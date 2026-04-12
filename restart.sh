#!/bin/bash
# Restart Claude Cockpit backend
PORT=8420

echo "=== Cockpit Backend Restart ==="

# Kill existing process on port 8420
PID=$(netstat -ano 2>/dev/null | grep ":${PORT}.*LISTEN" | awk '{print $NF}' | head -1)
if [ -n "$PID" ]; then
    echo "Killing PID $PID on port $PORT..."
    taskkill //F //PID "$PID" 2>/dev/null
    sleep 1
    echo "Killed."
else
    echo "Nothing running on port $PORT."
fi

# Start backend
cd /c/Code/Personal/claude-cockpit/web
echo "Starting backend..."
nohup python server.py >> /tmp/cockpit.log 2>&1 &
echo "Started. PID=$!"
echo "Log: tail -f /tmp/cockpit.log"
