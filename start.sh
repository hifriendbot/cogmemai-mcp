#!/bin/bash
export PATH=$HOME/bin:$PATH
export COGMEMAI_TRANSPORT=http
export MCP_PORT=3100
cd $HOME/cogmemai-mcp
nohup node build/index.js serve >> $HOME/cogmemai-mcp/server.log 2>&1 &
echo $! > $HOME/cogmemai-mcp/server.pid
