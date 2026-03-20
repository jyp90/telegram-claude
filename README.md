# telegram-claude

Custom Telegram MCP server for Claude Code that bypasses organization `--channels` policy restriction.

## Why?

The official Claude Code Telegram plugin uses the `--channels` flag to spawn its server. Organization policies can block this mechanism. This custom MCP server registers via `mcpServers` in `settings.json` instead, which is not subject to the same restrictions.

## Architecture

```
Telegram Bot API
     | long polling (grammy)
     v
[bun server.ts] ── MCP stdio ──> Claude Code
  |
  +-- message queue (in-memory, max 100)
  |     |
  |     +-- get_messages tool (Claude pulls messages)
  |
  +-- reply tool ──> bot.api.sendMessage
  +-- react tool ──> bot.api.setMessageReaction
  +-- edit_message ──> bot.api.editMessageText
  +-- get_bot_info ──> bot status
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Claude Code (Team/Enterprise plan)

### 1. Clone

```bash
git clone https://github.com/jyp90/telegram-claude ~/.claude/mcp/telegram-claude
cd ~/.claude/mcp/telegram-claude
```

### 2. Configure Telegram credentials

```bash
# Create config directory (skip if already exists)
mkdir -p ~/.claude/channels/telegram

# Set bot token
echo 'TELEGRAM_BOT_TOKEN=your-token-here' > ~/.claude/channels/telegram/.env

# Set allowed Telegram user IDs
cat > ~/.claude/channels/telegram/access.json << 'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_TELEGRAM_USER_ID"],
  "groups": {},
  "pending": {}
}
EOF
```

To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot) on Telegram.

### 3. Run setup

```bash
chmod +x setup.sh
./setup.sh
```

This will:
- Install dependencies
- Register the MCP server in `~/.claude/settings.json`
- Configure auto-allow for all tools

### 4. Restart Claude Code

Restart Claude Code to pick up the new MCP server. Verify with `/mcp` command.

## Usage

### Manual polling

In Claude Code, call the `get_messages` tool to check for new Telegram messages:

```
Check for new telegram messages using get_messages and reply to them
```

### Automated polling with /loop

```bash
/loop 30s "Check telegram messages with get_messages. If there are new messages, process and reply to each one."
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_messages` | Get queued Telegram messages (pull model) |
| `reply` | Send a message to a Telegram chat |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent bot message |
| `get_bot_info` | Get bot username and status |

## Configuration

### Bot Token

Stored in `~/.claude/channels/telegram/.env`:

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
```

### Access Control

Stored in `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["7984111392"],
  "groups": {},
  "pending": {}
}
```

- `allowFrom`: Array of Telegram user IDs allowed to send messages
- `groups`: Group chat configuration (optional)

### Message Chunking

Optional settings in `access.json`:

```json
{
  "textChunkLimit": 4096,
  "chunkMode": "newline",
  "replyToMode": "first"
}
```

## Manual settings.json Configuration

If you prefer manual setup over `setup.sh`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "/path/to/bun",
      "args": ["run", "/path/to/telegram-claude/server.ts"],
      "alwaysAllow": [
        "get_messages",
        "reply",
        "react",
        "edit_message",
        "get_bot_info"
      ]
    }
  }
}
```

## Differences from Official Plugin

| Aspect | Official Plugin | This MCP Server |
|--------|----------------|-----------------|
| Registration | `--channels` flag | `mcpServers` in settings.json |
| Inbound delivery | Push (notifications) | Pull (`get_messages` tool) |
| Org policy | Can be blocked | Not restricted |
| Pairing | Full pairing flow | Pre-configured allowlist |
| Runtime | Bun | Bun |
| Dependencies | Same | Same |

## Troubleshooting

### MCP server not showing up

- Restart Claude Code after setup
- Check `/mcp` command output
- Verify `~/.claude/settings.json` has the telegram entry

### Bot not receiving messages

- Check `TELEGRAM_BOT_TOKEN` in `.env`
- Ensure your user ID is in `access.json` `allowFrom`
- Check stderr output for error messages

### Messages not appearing

- Call `get_messages` tool -- messages are queued until pulled
- Max queue size is 100; oldest messages are dropped on overflow

## License

MIT
