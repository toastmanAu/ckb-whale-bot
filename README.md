# CKB Whale Alert Bot 🐋

Monitors a local [Nervos CKB](https://nervos.org) full node for large on-chain transactions and sends alerts to a Telegram chat.

## Features

- Alerts on any transaction with total output ≥ 10,000,000 CKB
- Skips coinbase (miner reward) transactions
- Filters self-transfers — ignores consolidation/change transactions where all outputs return to the same addresses as the inputs
- Crash-resilient polling loop with graceful shutdown
- Persists last-seen block across restarts

## Requirements

- Node.js 16+
- A synced CKB full node with RPC accessible
- A Telegram bot token and target chat ID

## Setup

```bash
cp config.example.json config.json
# Edit config.json with your values
node whale-bot.js
```

### Config options

| Key         | Env var     | Default                  | Description                        |
|-------------|-------------|--------------------------|------------------------------------|
| `ckb_rpc`   | `CKB_RPC`   | `http://127.0.0.1:8114`  | CKB node JSON-RPC endpoint         |
| `bot_token` | `BOT_TOKEN` | *(required)*             | Telegram bot token                 |
| `chat_id`   | `CHAT_ID`   | *(required)*             | Telegram chat/group ID to alert    |

Environment variables take priority over `config.json`.

## Running as a service

```bash
# Simple background start
nohup node whale-bot.js >> whale-bot.log 2>&1 &

# Or use start.sh if provided
bash start.sh
```

## Alert format

```
🐋 CKB Whale Alert

17.50M CKB moved on-chain

💰 Total output: 17,500,000 CKB
📦 Largest output: 15,000,000 CKB
🔀 Inputs → Outputs: 3 → 2
📏 Block: 18,500,000

🔗 0x1a2b3c4d5e6f...abc123
```

## Threshold

Default: 10,000,000 CKB. Change `WHALE_THRESHOLD` in `whale-bot.js`.
