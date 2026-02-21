#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/whale-bot.pid"
LOG_FILE="$DIR/whale-bot.log"

# Kill any existing instance
if [ -f "$PID_FILE" ]; then
    OLD=$(cat "$PID_FILE")
    kill "$OLD" 2>/dev/null || true
fi

setsid node "$DIR/whale-bot.js" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "whale-bot started PID=$(cat "$PID_FILE")"
