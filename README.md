# TradingPro Auto Trading Backend

Automated trading system using NestJS, MT5 API, ICT (Inner Circle Trader) concepts, and OpenAI for intelligent trade decisions.

## Features

- **MT5 Integration**: Full integration with MetaTrader 5 via REST API
- **ICT Trading Strategy**: Implements key ICT concepts:
  - Market Structure Analysis (Higher Highs, Higher Lows, BOS, CHoCH)
  - Order Blocks (Bullish and Bearish)
  - Fair Value Gaps (FVG)
  - Liquidity Levels (Buy-side and Sell-side)
  - Kill Zones (London, New York sessions)
- **AI-Powered Analysis**: Uses OpenAI GPT-4 for enhanced market analysis
- **Auto Trading**: Cron job runs every 15 minutes aligned with M15 candle close
- **MongoDB Database**: Stores trades, signals, market data, and logs (optimized for serverless)
- **REST API**: Full API for monitoring and control

## Prerequisites

- Node.js 18+ 
- MongoDB (Atlas recommended for serverless)
- MT5 Account (demo or live)
- OpenAI API Key

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd tradingpro_backend_nestjs
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your credentials
```

4. Set up MongoDB:
   - Create a MongoDB Atlas cluster (recommended) or use local MongoDB
   - Get your connection string

5. Run the application:
```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| MONGODB_URI | MongoDB connection string | mongodb://localhost:27017/tradingpro |
| MT5_API_BASE_URL | MT5 REST API URL | https://mt5.mtapi.io |
| MT5_USER | MT5 account number | - |
| MT5_PASSWORD | MT5 password | - |
| MT5_HOST | MT5 broker host | - |
| MT5_PORT | MT5 broker port | 443 |
| OPENAI_API_KEY | OpenAI API key | - |
| TRADING_SYMBOL | Trading pair | XAUUSDm |
| TRADING_TIMEFRAME | Timeframe | M15 |
| TRADING_LOT_SIZE | Lot size per trade | 0.01 |
| TRADING_MAX_POSITIONS | Max concurrent positions | 3 |
| AUTO_TRADING_ENABLED | Enable/disable auto trading | true |

## API Endpoints

### Trading
- `GET /trading/status` - Get auto trading status
- `POST /trading/trigger` - Manually trigger trading cycle
- `GET /trading/analyze` - Analyze market without executing
- `GET /trading/trades/open` - Get open trades
- `GET /trading/signals` - Get recent signals
- `GET /trading/logs` - Get trading logs
- `GET /trading/stats` - Get trade statistics

### Analysis
- `GET /analysis/full` - Full market analysis with ICT + AI
- `GET /analysis/market-structure` - Market structure only
- `GET /analysis/order-blocks` - Order blocks
- `GET /analysis/fair-value-gaps` - Fair value gaps
- `GET /analysis/liquidity` - Liquidity levels

### MT5
- `GET /mt5/connect` - Connect to MT5
- `GET /mt5/account` - Get account summary
- `GET /mt5/quote` - Get current quote
- `GET /mt5/history` - Get price history
- `GET /mt5/orders` - Get open orders
- `POST /mt5/order/send` - Send order
- `POST /mt5/order/close` - Close order

## ICT Strategy Implementation

### Market Structure
The system identifies:
- **Swing Highs/Lows**: Key market turning points
- **Higher Highs (HH) / Higher Lows (HL)**: Bullish structure
- **Lower Highs (LH) / Lower Lows (LL)**: Bearish structure
- **Break of Structure (BOS)**: Trend continuation signal
- **Change of Character (CHoCH)**: Potential reversal signal

### Order Blocks
- **Bullish OB**: Last bearish candle before strong bullish move
- **Bearish OB**: Last bullish candle before strong bearish move
- Validated based on whether they've been mitigated

### Fair Value Gaps
- **Bullish FVG**: Gap between candle 1 high and candle 3 low
- **Bearish FVG**: Gap between candle 1 low and candle 3 high
- Tracks fill percentage for trading opportunities

### Liquidity
- **Buy-side Liquidity**: Above swing highs (stops of short positions)
- **Sell-side Liquidity**: Below swing lows (stops of long positions)
- Identifies equal highs/lows as liquidity pools

### Kill Zones (High Probability Times)
- Asian Session: 00:00-08:00 UTC
- London Open: 07:00-10:00 UTC
- New York Open: 12:00-15:00 UTC
- London Close: 15:00-17:00 UTC

## Trade Execution Logic

1. **Every 15 minutes** (aligned with M15 candle close):
   - Fetch latest price data from MT5
   - Perform ICT analysis
   - Get AI recommendation from OpenAI
   - Generate trading signal

2. **Signal Requirements**:
   - Minimum 2 confluences
   - Minimum 50% confidence
   - Minimum 1.5:1 risk-reward ratio
   - Must be in a kill zone (optional but preferred)

3. **Trade Execution**:
   - Check if auto trading is enabled
   - Verify max positions not reached
   - Confirm market is open
   - Send order to MT5

## Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f app
```

## Monitoring

Access Swagger documentation at: `http://localhost:3000/api`

## Risk Warning

⚠️ **Trading involves significant risk of loss. This software is for educational purposes. Use at your own risk. Always test with a demo account first.**

## License

MIT
