#!/bin/bash
# setup.sh - Register telegram-claude MCP server in Claude Code settings.json
#
# Usage:
#   ./setup.sh              # Auto-detect paths
#   ./setup.sh /path/to/dir # Custom install directory

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SETTINGS_FILE="$HOME/.claude/settings.json"
INSTALL_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
BUN_PATH="$HOME/.bun/bin/bun"

echo "=== Telegram Claude MCP Server Setup ==="
echo ""

# Check bun
if [ ! -f "$BUN_PATH" ]; then
  BUN_PATH=$(which bun 2>/dev/null || true)
  if [ -z "$BUN_PATH" ]; then
    echo -e "${RED}Error: bun not found. Install: curl -fsSL https://bun.sh/install | bash${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}bun:${NC} $BUN_PATH"

# Check bot token
ENV_FILE="$HOME/.claude/channels/telegram/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Error: $ENV_FILE not found. Create it with:${NC}"
  echo "  mkdir -p ~/.claude/channels/telegram"
  echo "  echo 'TELEGRAM_BOT_TOKEN=your-token-here' > ~/.claude/channels/telegram/.env"
  exit 1
fi
echo -e "${GREEN}token:${NC} $ENV_FILE"

# Check access.json
ACCESS_FILE="$HOME/.claude/channels/telegram/access.json"
if [ ! -f "$ACCESS_FILE" ]; then
  echo -e "${YELLOW}Warning: $ACCESS_FILE not found. Creating default...${NC}"
  mkdir -p "$(dirname "$ACCESS_FILE")"
  echo '{"dmPolicy":"allowlist","allowFrom":[],"groups":{},"pending":{}}' > "$ACCESS_FILE"
  echo -e "${YELLOW}Add your Telegram user ID to allowFrom in access.json${NC}"
fi
echo -e "${GREEN}access:${NC} $ACCESS_FILE"

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$INSTALL_DIR"
"$BUN_PATH" install --no-summary
echo -e "${GREEN}Dependencies installed.${NC}"

# Update settings.json
echo ""
echo "Updating $SETTINGS_FILE..."

if [ ! -f "$SETTINGS_FILE" ]; then
  echo -e "${RED}Error: $SETTINGS_FILE not found.${NC}"
  exit 1
fi

# Use bun to safely merge JSON
"$BUN_PATH" -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const settings = JSON.parse(fs.readFileSync(path, 'utf8'));

if (!settings.mcpServers) settings.mcpServers = {};

settings.mcpServers.telegram = {
  command: '$BUN_PATH',
  args: ['run', '$INSTALL_DIR/server.ts'],
  alwaysAllow: [
    'get_messages',
    'reply',
    'react',
    'edit_message',
    'get_bot_info'
  ]
};

fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('settings.json updated successfully');
"

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code (or run /mcp to verify)"
echo "  2. Send a Telegram message to your bot"
echo "  3. In Claude Code, call: get_messages"
echo "  4. Or use: /loop 30s 'check telegram with get_messages and reply'"
echo ""
echo "To uninstall, remove the 'telegram' key from mcpServers in settings.json"
