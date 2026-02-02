CREATE TABLE IF NOT EXISTS mt5_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "accountId" VARCHAR UNIQUE,
    token TEXT,
    "user" VARCHAR,
    password TEXT,
    host VARCHAR,
    port INTEGER,
    "isConnected" BOOLEAN DEFAULT false,
    balance DECIMAL(15,2),
    equity DECIMAL(15,2),
    "freeMargin" DECIMAL(15,2),
    leverage VARCHAR,
    currency VARCHAR,
    "serverName" VARCHAR,
    "lastConnectedAt" TIMESTAMP,
    "createdAt" TIMESTAMP DEFAULT NOW(),
    "updatedAt" TIMESTAMP DEFAULT NOW()
);

ALTER TABLE mt5_connections ADD COLUMN IF NOT EXISTS password TEXT;
