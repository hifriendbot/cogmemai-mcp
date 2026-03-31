#!/bin/bash
export PATH=$HOME/bin:$PATH

# Check if server is actually responding, not just if process exists
if curl -s --connect-timeout 2 http://localhost:3100/health > /dev/null 2>&1; then
    exit 0
fi

# Server not responding — kill any stale processes and restart
pkill -9 -f "cogmemai-mcp/build/index.js serve" 2>/dev/null
sleep 1

export COGMEMAI_TRANSPORT=http
export MCP_PORT=3100
cd $HOME/cogmemai-mcp
nohup node build/index.js serve >> $HOME/cogmemai-mcp/server.log 2>&1 &
echo $! > $HOME/cogmemai-mcp/server.pid
