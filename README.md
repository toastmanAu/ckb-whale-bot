# ckb-whale-bot

Telegram alert bot for large CKB transfers on the Nervos Network.

Monitors a local CKB full node for transactions above a configurable USD threshold and sends alerts to a Telegram group.

---

## What it does

- **Watches your local CKB node** — polls new blocks as they arrive (~6s intervals)
- **USD-value threshold** — live CKB price from CoinGecko (5-minute cache), falls back to raw CKB amount if unavailable
- **Self-transfer filtering** — skips transactions where all outputs go back to the same lock args
- **Cellbase skipping** — ignores miner reward transactions
- **Telegram alerts** — sends to a configured group/channel

---

## Setup

```bash
git clone https://github.com/toastmanAu/ckb-whale-bot
cd ckb-whale-bot
cp config.example.json config.json
# Edit config.json
node whale-bot.js
```

### config.json

```json
{
  "ckbNodeUrl": "http://192.168.68.87:8114",
  "telegramToken": "YOUR_BOT_TOKEN",
  "telegramChatId": "-1001234567890",
  "thresholdUsd": 200000,
  "fallbackThresholdCkb": 10000000
}
```

`config.json` is gitignored — never committed.

---

## Running

```bash
# Direct
node whale-bot.js

# Via start script (backgrounds, writes PID file)
bash start.sh

# Check if running
ps aux | grep whale-bot | grep -v grep
```

---

## Threshold logic

1. Fetches live CKB/USD price from CoinGecko every 5 minutes
2. Converts `thresholdUsd` to CKB using live price
3. If CoinGecko is unreachable, uses `fallbackThresholdCkb` directly

---

## Alert format

```
🐋 Whale Alert — 15,420,000 CKB (~$308,400 USD)

Block: 18,734,521
TX: 0x1a2b3c...
Inputs: 3  →  Outputs: 2
```

---

## Requirements

- CKB full node with RPC accessible
- Telegram bot token + chat ID
- Node.js 18+

---

## License

MIT
