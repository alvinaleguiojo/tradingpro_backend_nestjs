//+------------------------------------------------------------------+
//|                                                TradingProEA.mq5  |
//|                                   TradingPro EA Bridge v3.0      |
//|   Pushes market data to backend, receives and executes commands   |
//+------------------------------------------------------------------+
#property copyright "TradingPro"
#property link      "https://tradingpro-backend-nestjs.vercel.app"
#property version   "3.10"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- Input Parameters
input string   InpApiBaseUrl     = "https://tradingpro-backend-nestjs.vercel.app"; // API Base URL
input string   InpSymbol         = "XAUUSDm";       // Trading Symbol
input int      InpPollSeconds    = 5;               // Sync interval (seconds)
input int      InpCandleCount    = 100;             // Number of M5 candles to send
input int      InpSlippage       = 30;              // Max slippage (points)
input ulong    InpMagicNumber    = 202602;          // Magic Number
input bool     InpShowPanel      = true;            // Show panel on chart
input string   InpEaSyncSecret   = "";              // EA sync secret (maps to backend EA_SYNC_SECRET)
input string   InpApiKey         = "";              // API Key (optional)

//--- Execution Result Tracking
struct PendingResult
  {
   string         commandId;
   bool           success;
   string         ticket;
   double         price;
   string         error;
  };

PendingResult  g_results[];
int            g_resultCount = 0;
datetime       g_lastDealSyncTime = 0;
datetime       g_pendingDealSyncTime = 0;

//--- State
string         g_apiUrl;
string         g_accountId;
CTrade         g_trade;
bool           g_running = true;
int            g_totalExecuted = 0;
int            g_totalFailed = 0;
int            g_syncCount = 0;
string         g_lastStatus = "Initializing...";
string         g_lastSignal = "None";
int            g_nextAnalysisIn = 0;
int            g_panelX = 10;
int            g_panelY = 30;

//+------------------------------------------------------------------+
//| JSON Helper: Extract string value                                 |
//+------------------------------------------------------------------+
string JsonGetString(const string &json, const string key)
  {
   string search = "\"" + key + "\"";
   int pos = StringFind(json, search);
   if(pos < 0) return "";

   int colonPos = StringFind(json, ":", pos + StringLen(search));
   if(colonPos < 0) return "";

   int start = colonPos + 1;
   while(start < StringLen(json) && (StringGetCharacter(json, start) == ' ' || StringGetCharacter(json, start) == '\t'))
      start++;

   if(StringGetCharacter(json, start) == '"')
     {
      start++;
      int end = start;
      while(end < StringLen(json))
        {
         if(StringGetCharacter(json, end) == '"' && (end == 0 || StringGetCharacter(json, end - 1) != '\\'))
            break;
         end++;
        }
      return StringSubstr(json, start, end - start);
     }

   int end = start;
   while(end < StringLen(json))
     {
      ushort ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}' || ch == ']' || ch == '\n' || ch == '\r')
         break;
      end++;
     }
   string val = StringSubstr(json, start, end - start);
   StringTrimRight(val);
   StringTrimLeft(val);
   return val;
  }

double JsonGetDouble(const string &json, const string key)
  {
   string val = JsonGetString(json, key);
   if(val == "" || val == "null") return 0.0;
   return StringToDouble(val);
  }

//+------------------------------------------------------------------+
//| HTTP POST Request                                                 |
//+------------------------------------------------------------------+
string HttpPost(const string url, const string body)
  {
   string headers = "Content-Type: application/json\r\n";
   string eaSecret = InpEaSyncSecret;
   if(eaSecret == "" && InpApiKey != "")
      eaSecret = InpApiKey; // Backward compatibility for older EA config

   if(eaSecret != "")
      headers += "x-ea-secret: " + eaSecret + "\r\n";

   if(InpApiKey != "")
      headers += "X-Api-Key: " + InpApiKey + "\r\n";

   char   postData[];
   char   resultData[];
   string resultHeaders;

   StringToCharArray(body, postData, 0, StringLen(body));

   ResetLastError();
   int res = WebRequest("POST", url, headers, 10000, postData, resultData, resultHeaders);

   if(res == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         Alert("Add '" + InpApiBaseUrl + "' to Tools > Options > Expert Advisors > Allow WebRequest");
      return "";
     }

   return CharArrayToString(resultData, 0, WHOLE_ARRAY, CP_UTF8);
  }

string HttpGet(const string url)
  {
   string headers = "";
   char   postData[];
   char   resultData[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("GET", url, headers, 10000, postData, resultData, resultHeaders);
   if(res == -1) return "";
   return CharArrayToString(resultData, 0, WHOLE_ARRAY, CP_UTF8);
  }

//+------------------------------------------------------------------+
//| Build JSON array of M5 candles                                    |
//+------------------------------------------------------------------+
string BuildCandlesJson()
  {
   MqlRates rates[];
   int copied = CopyRates(InpSymbol, PERIOD_M5, 0, InpCandleCount, rates);
   if(copied <= 0) return "[]";

   string json = "[";
   for(int i = 0; i < copied; i++)
     {
      if(i > 0) json += ",";
      json += "{";
      json += "\"time\":\"" + TimeToString(rates[i].time, TIME_DATE | TIME_SECONDS) + "\",";
      json += "\"open\":" + DoubleToString(rates[i].open, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"high\":" + DoubleToString(rates[i].high, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"low\":" + DoubleToString(rates[i].low, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"close\":" + DoubleToString(rates[i].close, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"tickVolume\":" + IntegerToString(rates[i].tick_volume);
      json += "}";
     }
   json += "]";
   return json;
  }

//+------------------------------------------------------------------+
//| Build JSON of account info                                        |
//+------------------------------------------------------------------+
string BuildAccountJson()
  {
   string json = "{";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   json += "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\"";
   json += "}";
   return json;
  }

//+------------------------------------------------------------------+
//| Build JSON of current quote                                       |
//+------------------------------------------------------------------+
string BuildQuoteJson()
  {
   string json = "{";
   int digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   json += "\"bid\":" + DoubleToString(SymbolInfoDouble(InpSymbol, SYMBOL_BID), digits) + ",";
   json += "\"ask\":" + DoubleToString(SymbolInfoDouble(InpSymbol, SYMBOL_ASK), digits) + ",";
   json += "\"time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\"";
   json += "}";
   return json;
  }

//+------------------------------------------------------------------+
//| Build JSON array of open positions                                |
//+------------------------------------------------------------------+
string BuildPositionsJson()
  {
   string json = "[";
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      // Only include positions for our symbol or all if needed
      string posSymbol = PositionGetString(POSITION_SYMBOL);

      if(count > 0) json += ",";
      json += "{";
      json += "\"ticket\":\"" + IntegerToString(ticket) + "\",";
      json += "\"symbol\":\"" + posSymbol + "\",";
      json += "\"type\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
      json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",";
      json += "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), (int)SymbolInfoInteger(posSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"stopLoss\":" + DoubleToString(PositionGetDouble(POSITION_SL), (int)SymbolInfoInteger(posSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"takeProfit\":" + DoubleToString(PositionGetDouble(POSITION_TP), (int)SymbolInfoInteger(posSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
      json += "\"openTime\":\"" + TimeToString((datetime)PositionGetInteger(POSITION_TIME), TIME_DATE | TIME_SECONDS) + "\",";
      json += "\"comment\":\"" + PositionGetString(POSITION_COMMENT) + "\"";
      json += "}";
      count++;
     }

   json += "]";
   return json;
  }

//+------------------------------------------------------------------+
//| Build JSON array of execution results                             |
//+------------------------------------------------------------------+
string BuildResultsJson()
  {
   if(g_resultCount == 0) return "[]";

   string json = "[";
   for(int i = 0; i < g_resultCount; i++)
     {
      if(i > 0) json += ",";
      json += "{";
      json += "\"commandId\":\"" + g_results[i].commandId + "\",";
      json += "\"success\":" + (g_results[i].success ? "true" : "false") + ",";
      json += "\"ticket\":\"" + g_results[i].ticket + "\",";
      json += "\"price\":" + DoubleToString(g_results[i].price, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + ",";
      json += "\"error\":\"" + g_results[i].error + "\"";
      json += "}";
     }
   json += "]";

   // Clear results after building
   g_resultCount = 0;
   ArrayResize(g_results, 0);

   return json;
  }

//+------------------------------------------------------------------+
//| Build JSON array of closed deals from MT5 history                |
//+------------------------------------------------------------------+
string BuildClosedDealsJson()
  {
   datetime toTime = TimeCurrent();
   datetime fromTime = (g_lastDealSyncTime > 0) ? (g_lastDealSyncTime - 2) : (toTime - 3 * 24 * 60 * 60);
   if(fromTime < 0) fromTime = 0;

   g_pendingDealSyncTime = g_lastDealSyncTime;

   if(!HistorySelect(fromTime, toTime))
      return "[]";

   int total = HistoryDealsTotal();
   if(total <= 0) return "[]";

   string json = "[";
   int count = 0;
   datetime maxDealTime = g_lastDealSyncTime;

   for(int i = 0; i < total; i++)
     {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;

      long entry = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;

      datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
      if(g_lastDealSyncTime > 0 && dealTime <= g_lastDealSyncTime) continue;

      long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
      if(dealType != DEAL_TYPE_BUY && dealType != DEAL_TYPE_SELL) continue;

      string symbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
      string type = (dealType == DEAL_TYPE_BUY) ? "BUY" : "SELL";
      double volume = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
      double closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
      double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
      double commission = HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      double swap = HistoryDealGetDouble(dealTicket, DEAL_SWAP);
      long positionId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

      if(count > 0) json += ",";
      json += "{";
      json += "\"ticket\":\"" + IntegerToString((long)dealTicket) + "\",";
      json += "\"positionTicket\":\"" + IntegerToString(positionId) + "\",";
      json += "\"symbol\":\"" + symbol + "\",";
      json += "\"type\":\"" + type + "\",";
      json += "\"volume\":" + DoubleToString(volume, 2) + ",";
      json += "\"closePrice\":" + DoubleToString(closePrice, digits) + ",";
      json += "\"profit\":" + DoubleToString(profit, 2) + ",";
      json += "\"commission\":" + DoubleToString(commission, 2) + ",";
      json += "\"swap\":" + DoubleToString(swap, 2) + ",";
      json += "\"closeTime\":\"" + TimeToString(dealTime, TIME_DATE | TIME_SECONDS) + "\"";
      json += "}";
      count++;

      if(dealTime > maxDealTime)
         maxDealTime = dealTime;
     }

   json += "]";
   g_pendingDealSyncTime = maxDealTime;
   return json;
  }

//+------------------------------------------------------------------+
//| Build full sync payload                                           |
//+------------------------------------------------------------------+
string BuildSyncPayload()
  {
   string json = "{";
   json += "\"accountId\":\"" + g_accountId + "\",";
   json += "\"symbol\":\"" + InpSymbol + "\",";
   json += "\"account\":" + BuildAccountJson() + ",";
   json += "\"quote\":" + BuildQuoteJson() + ",";
   json += "\"candles\":" + BuildCandlesJson() + ",";
   json += "\"positions\":" + BuildPositionsJson() + ",";
   json += "\"executionResults\":" + BuildResultsJson() + ",";
   json += "\"closedDeals\":" + BuildClosedDealsJson() + ",";
   json += "\"eaVersion\":\"3.1\"";
   json += "}";
   return json;
  }

//+------------------------------------------------------------------+
//| Extract commands array from sync response                         |
//+------------------------------------------------------------------+
int ParseCommands(const string &response, string &commands[])
  {
   // Find "commands" array
   int cmdPos = StringFind(response, "\"commands\"");
   if(cmdPos < 0) return 0;

   int bracketStart = StringFind(response, "[", cmdPos);
   if(bracketStart < 0) return 0;

   int count = 0;
   int depth = 0;
   int objStart = -1;

   for(int i = bracketStart + 1; i < StringLen(response); i++)
     {
      ushort ch = StringGetCharacter(response, i);
      if(ch == '{')
        {
         if(depth == 0) objStart = i;
         depth++;
        }
      else if(ch == '}')
        {
         depth--;
         if(depth == 0 && objStart >= 0)
           {
            count++;
            ArrayResize(commands, count);
            commands[count - 1] = StringSubstr(response, objStart, i - objStart + 1);
            objStart = -1;
           }
        }
      else if(ch == ']' && depth == 0)
         break;
     }

   return count;
  }

//+------------------------------------------------------------------+
//| Execute a single command from backend                             |
//+------------------------------------------------------------------+
void ExecuteCommand(const string &cmdJson)
  {
   string cmdId   = JsonGetString(cmdJson, "id");
   string cmdType = JsonGetString(cmdJson, "type");
   string symbol  = JsonGetString(cmdJson, "symbol");
   double volume  = JsonGetDouble(cmdJson, "volume");
   double sl      = JsonGetDouble(cmdJson, "stopLoss");
   double tp      = JsonGetDouble(cmdJson, "takeProfit");
   string ticket  = JsonGetString(cmdJson, "ticket");
   string comment = JsonGetString(cmdJson, "comment");

   if(symbol == "") symbol = InpSymbol;
   if(comment == "") comment = "EA_" + cmdType;

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   g_trade.SetExpertMagicNumber(InpMagicNumber);
   g_trade.SetDeviationInPoints(InpSlippage);

   bool success = false;
   string resultTicket = "";
   double resultPrice = 0;
   string resultError = "";

   //--- BUY
   if(cmdType == "BUY")
     {
      double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
      if(volume <= 0) volume = 0.01;
      success = g_trade.Buy(volume, symbol, ask, sl, tp, comment);
      if(success)
        {
         resultTicket = IntegerToString(g_trade.ResultOrder());
         resultPrice = g_trade.ResultPrice();
         g_totalExecuted++;
         Print("EXECUTED BUY: ", volume, " ", symbol, " @ ", resultPrice, " ticket #", resultTicket);
        }
      else
        {
         resultError = g_trade.ResultRetcodeDescription();
         g_totalFailed++;
         Print("FAILED BUY: ", resultError);
        }
     }
   //--- SELL
   else if(cmdType == "SELL")
     {
      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
      if(volume <= 0) volume = 0.01;
      success = g_trade.Sell(volume, symbol, bid, sl, tp, comment);
      if(success)
        {
         resultTicket = IntegerToString(g_trade.ResultOrder());
         resultPrice = g_trade.ResultPrice();
         g_totalExecuted++;
         Print("EXECUTED SELL: ", volume, " ", symbol, " @ ", resultPrice, " ticket #", resultTicket);
        }
      else
        {
         resultError = g_trade.ResultRetcodeDescription();
         g_totalFailed++;
         Print("FAILED SELL: ", resultError);
        }
     }
   //--- CLOSE
   else if(cmdType == "CLOSE")
     {
      if(ticket != "" && ticket != "0")
        {
         ulong posTicket = (ulong)StringToInteger(ticket);
         success = g_trade.PositionClose(posTicket, InpSlippage);
         if(success)
           {
            resultTicket = ticket;
            resultPrice = g_trade.ResultPrice();
            g_totalExecuted++;
            Print("CLOSED position #", ticket, " @ ", resultPrice);
           }
         else
           {
            resultError = g_trade.ResultRetcodeDescription();
            g_totalFailed++;
            Print("CLOSE FAILED #", ticket, ": ", resultError);
           }
        }
      else
        {
         resultError = "Invalid ticket";
         g_totalFailed++;
        }
     }
   //--- MODIFY
   else if(cmdType == "MODIFY")
     {
      if(ticket != "" && ticket != "0")
        {
         ulong posTicket = (ulong)StringToInteger(ticket);
         success = g_trade.PositionModify(posTicket, sl, tp);
         if(success)
           {
            resultTicket = ticket;
            g_totalExecuted++;
            Print("MODIFIED #", ticket, " SL:", sl, " TP:", tp);
           }
         else
           {
            resultError = g_trade.ResultRetcodeDescription();
            g_totalFailed++;
            Print("MODIFY FAILED #", ticket, ": ", resultError);
           }
        }
      else
        {
         resultError = "Invalid ticket";
         g_totalFailed++;
        }
     }

   // Store result for next sync
   g_resultCount++;
   ArrayResize(g_results, g_resultCount);
   g_results[g_resultCount - 1].commandId = cmdId;
   g_results[g_resultCount - 1].success   = success;
   g_results[g_resultCount - 1].ticket    = resultTicket;
   g_results[g_resultCount - 1].price     = resultPrice;
   g_results[g_resultCount - 1].error     = resultError;

   g_lastStatus = (success ? "OK " : "FAIL ") + cmdType + " " + symbol;
   UpdatePanel();
  }

//+------------------------------------------------------------------+
//| MAIN SYNC: Push data, receive and execute commands                |
//+------------------------------------------------------------------+
void SyncWithBackend()
  {
   if(!g_running) return;

   // Build and send sync payload
   string payload = BuildSyncPayload();
   string url = g_apiUrl + "/ea/sync";
   string response = HttpPost(url, payload);

   g_syncCount++;

   if(response == "")
     {
      g_lastStatus = "Sync failed: no response";
      UpdatePanel();
      return;
     }

   // Parse response
   string successStr = JsonGetString(response, "success");
   if(successStr != "true")
     {
      string error = JsonGetString(response, "error");
      g_lastStatus = "API error: " + error;
      UpdatePanel();
      return;
     }

   if(g_pendingDealSyncTime > g_lastDealSyncTime)
      g_lastDealSyncTime = g_pendingDealSyncTime;

   // Get analysis info
   string analysisRun = JsonGetString(response, "analysisRun");
   g_nextAnalysisIn = (int)StringToInteger(JsonGetString(response, "nextAnalysisIn"));

   if(analysisRun == "true")
     {
      // Extract signal info if available
      string sigType = JsonGetString(response, "signalType");
      string sigConf = JsonGetString(response, "confidence");
      if(sigType != "" && sigType != "HOLD")
         g_lastSignal = sigType + " (" + sigConf + "%)";
      else if(sigType == "HOLD" || sigType == "")
         g_lastSignal = "HOLD / No setup";
     }

   // Process commands
   string commands[];
   int cmdCount = ParseCommands(response, commands);

   if(cmdCount > 0)
     {
      Print("Received ", cmdCount, " commands from backend");
      for(int i = 0; i < cmdCount; i++)
        {
         ExecuteCommand(commands[i]);
         if(i < cmdCount - 1) Sleep(200); // Small delay between commands
        }
     }

   // Update status
   int posCount = PositionsTotal();
   g_lastStatus = "Synced | Pos:" + IntegerToString(posCount)
                + " | Next:" + IntegerToString(g_nextAnalysisIn) + "s"
                + " | " + TimeToString(TimeCurrent(), TIME_MINUTES);
   UpdatePanel();
  }

//+------------------------------------------------------------------+
//| Panel: Create label                                               |
//+------------------------------------------------------------------+
void CreateLabel(const string name, const string text, int x, int y, color clr, int fontSize = 9)
  {
   if(ObjectFind(0, name) >= 0) ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fontSize);
   ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
  }

//+------------------------------------------------------------------+
//| Panel: Create button                                              |
//+------------------------------------------------------------------+
void CreateButton(const string name, const string text, int x, int y,
                  int w, int h, color bgClr, color txtClr)
  {
   if(ObjectFind(0, name) >= 0) ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
   ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, txtClr);
   ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bgClr);
   ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, clrNONE);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
   ObjectSetString(0, name, OBJPROP_FONT, "Arial Bold");
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_STATE, false);
  }

//+------------------------------------------------------------------+
//| Create full panel                                                 |
//+------------------------------------------------------------------+
void CreatePanel()
  {
   if(!InpShowPanel) return;
   int x = g_panelX, y = g_panelY;

   // Background
   if(ObjectFind(0, "tp_bg") >= 0) ObjectDelete(0, "tp_bg");
   ObjectCreate(0, "tp_bg", OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, "tp_bg", OBJPROP_XDISTANCE, x - 5);
   ObjectSetInteger(0, "tp_bg", OBJPROP_YDISTANCE, y - 25);
   ObjectSetInteger(0, "tp_bg", OBJPROP_XSIZE, 280);
   ObjectSetInteger(0, "tp_bg", OBJPROP_YSIZE, 195);
   ObjectSetInteger(0, "tp_bg", OBJPROP_BGCOLOR, C'20,20,30');
   ObjectSetInteger(0, "tp_bg", OBJPROP_BORDER_COLOR, clrDodgerBlue);
   ObjectSetInteger(0, "tp_bg", OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, "tp_bg", OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, "tp_bg", OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, "tp_bg", OBJPROP_WIDTH, 1);

   CreateLabel("tp_title",  "TradingPro EA Bridge v3", x, y - 20, clrGold, 11);
   CreateLabel("tp_mode",   "Mode: EA BRIDGE", x, y + 5, clrLime, 9);
   CreateLabel("tp_symbol", "Symbol: " + InpSymbol, x + 150, y + 5, clrSilver, 9);
   CreateLabel("tp_acct",   "Account: " + g_accountId, x, y + 22, clrSilver, 8);
   CreateLabel("tp_stats",  "Exec: 0 | Fail: 0 | Sync: 0", x, y + 38, clrCyan, 9);
   CreateLabel("tp_signal", "Signal: None", x, y + 55, clrWhite, 9);
   CreateLabel("tp_next",   "Next analysis: --", x, y + 72, clrSilver, 8);
   CreateLabel("tp_status", g_lastStatus, x, y + 89, clrSilver, 8);

   int btnY = y + 110;
   CreateButton("tp_pause", "PAUSE", x, btnY, 85, 28, clrDarkOrange, clrWhite);
   CreateButton("tp_sync",  "SYNC NOW", x + 90, btnY, 85, 28, clrMediumPurple, clrWhite);
   CreateButton("tp_close", "CLOSE ALL", x + 180, btnY, 85, 28, C'139,0,0', clrWhite);

   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| Update panel                                                      |
//+------------------------------------------------------------------+
void UpdatePanel()
  {
   if(!InpShowPanel) return;

   if(ObjectFind(0, "tp_stats") >= 0)
      ObjectSetString(0, "tp_stats", OBJPROP_TEXT,
         "Exec: " + IntegerToString(g_totalExecuted) +
         " | Fail: " + IntegerToString(g_totalFailed) +
         " | Sync: " + IntegerToString(g_syncCount));

   if(ObjectFind(0, "tp_signal") >= 0)
      ObjectSetString(0, "tp_signal", OBJPROP_TEXT, "Signal: " + g_lastSignal);

   if(ObjectFind(0, "tp_next") >= 0)
      ObjectSetString(0, "tp_next", OBJPROP_TEXT,
         "Next analysis: " + IntegerToString(g_nextAnalysisIn) + "s");

   if(ObjectFind(0, "tp_status") >= 0)
      ObjectSetString(0, "tp_status", OBJPROP_TEXT, g_lastStatus);

   if(ObjectFind(0, "tp_mode") >= 0)
     {
      if(g_running)
        {
         ObjectSetString(0, "tp_mode", OBJPROP_TEXT, "Mode: EA BRIDGE");
         ObjectSetInteger(0, "tp_mode", OBJPROP_COLOR, clrLime);
        }
      else
        {
         ObjectSetString(0, "tp_mode", OBJPROP_TEXT, "Mode: PAUSED");
         ObjectSetInteger(0, "tp_mode", OBJPROP_COLOR, clrOrangeRed);
        }
     }

   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| Remove panel                                                      |
//+------------------------------------------------------------------+
void RemovePanel()
  {
   string objects[] = {"tp_bg", "tp_title", "tp_mode", "tp_symbol", "tp_acct",
                       "tp_stats", "tp_signal", "tp_next", "tp_status",
                       "tp_pause", "tp_sync", "tp_close"};
   for(int i = 0; i < ArraySize(objects); i++)
      if(ObjectFind(0, objects[i]) >= 0)
         ObjectDelete(0, objects[i]);
   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| Handle button clicks                                              |
//+------------------------------------------------------------------+
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
  {
   if(id != CHARTEVENT_OBJECT_CLICK) return;
   ObjectSetInteger(0, sparam, OBJPROP_STATE, false);

   if(sparam == "tp_pause")
     {
      g_running = !g_running;
      if(g_running)
        {
         ObjectSetString(0, "tp_pause", OBJPROP_TEXT, "PAUSE");
         ObjectSetInteger(0, "tp_pause", OBJPROP_BGCOLOR, clrDarkOrange);
         Print("EA Bridge RESUMED");
        }
      else
        {
         ObjectSetString(0, "tp_pause", OBJPROP_TEXT, "RESUME");
         ObjectSetInteger(0, "tp_pause", OBJPROP_BGCOLOR, clrGreen);
         Print("EA Bridge PAUSED");
        }
      UpdatePanel();
     }
   else if(sparam == "tp_sync")
     {
      Print("Manual sync triggered");
      g_lastStatus = "Manual sync...";
      UpdatePanel();
      SyncWithBackend();
     }
   else if(sparam == "tp_close")
     {
      if(MessageBox("Close ALL positions?", "Confirm", MB_YESNO | MB_ICONWARNING) == IDYES)
        {
         for(int i = PositionsTotal() - 1; i >= 0; i--)
           {
            ulong ticket = PositionGetTicket(i);
            if(ticket > 0)
               g_trade.PositionClose(ticket, InpSlippage);
           }
         g_lastStatus = "All positions closed";
         UpdatePanel();
        }
     }

   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_apiUrl = InpApiBaseUrl;
   if(StringGetCharacter(g_apiUrl, StringLen(g_apiUrl) - 1) == '/')
      g_apiUrl = StringSubstr(g_apiUrl, 0, StringLen(g_apiUrl) - 1);

   g_accountId = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));

   g_trade.SetExpertMagicNumber(InpMagicNumber);
   g_trade.SetDeviationInPoints(InpSlippage);
   g_trade.SetTypeFilling(ORDER_FILLING_IOC);
   g_lastDealSyncTime = TimeCurrent() - (3 * 24 * 60 * 60);

   Print("=============================================");
   Print("  TradingPro EA Bridge v3.1");
   Print("  Mode: PUSH DATA + EXECUTE COMMANDS");
   Print("  API: ", g_apiUrl);
   Print("  Account: ", g_accountId);
   Print("  Symbol: ", InpSymbol);
    Print("  Poll: ", InpPollSeconds, "s");
    Print("  Candles: ", InpCandleCount);
    Print("  Magic: ", InpMagicNumber);
    Print("  EA Secret: ", (InpEaSyncSecret != "" || InpApiKey != "") ? "SET" : "MISSING");
    Print("=============================================");

    if(InpEaSyncSecret == "" && InpApiKey == "")
      {
       Print("WARNING: EA sync secret is missing. /ea/sync requests will return 401.");
      }

   // Test connection
   string health = HttpGet(g_apiUrl + "/health");
   if(health != "")
     {
      Print("API Connection: OK");
      g_lastStatus = "Connected";
     }
   else
     {
      Print("API Connection: FAILED");
      g_lastStatus = "API DISCONNECTED";
      Alert("Cannot connect to API! Add URL to WebRequest settings.");
     }

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     {
      Alert("Enable Algo Trading!");
      g_lastStatus = "Enable Algo Trading!";
     }

   CreatePanel();
   EventSetTimer(InpPollSeconds);

   // First sync immediately
   SyncWithBackend();

   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   RemovePanel();
   Print("EA Bridge stopped. Executed: ", g_totalExecuted, " Failed: ", g_totalFailed, " Syncs: ", g_syncCount);
  }

//+------------------------------------------------------------------+
//| Expert tick function                                              |
//+------------------------------------------------------------------+
void OnTick()
  {
  }

//+------------------------------------------------------------------+
//| Timer: Sync with backend                                          |
//+------------------------------------------------------------------+
void OnTimer()
  {
   if(g_running)
      SyncWithBackend();
  }
//+------------------------------------------------------------------+
