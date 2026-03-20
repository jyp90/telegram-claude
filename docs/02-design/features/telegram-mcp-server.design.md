# Design: Telegram Claude MCP Server

## 1. MCP Tool Specifications

### 1.1 get_messages

Polls the in-memory queue and returns all pending messages.

```json
{
  "name": "get_messages",
  "description": "Get new messages from Telegram. Returns all queued messages and clears the queue.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "number",
        "description": "Max messages to return. Default: all."
      }
    }
  }
}
```

**Response format:**
```json
{
  "messages": [
    {
      "chat_id": "7984111392",
      "message_id": "123",
      "user": "username",
      "user_id": "7984111392",
      "text": "Hello Claude",
      "ts": "2026-03-20T10:00:00.000Z",
      "image_path": "/path/to/photo.jpg"  // optional
    }
  ],
  "count": 1
}
```

### 1.2 reply

```json
{
  "name": "reply",
  "inputSchema": {
    "type": "object",
    "properties": {
      "chat_id": { "type": "string" },
      "text": { "type": "string" },
      "reply_to": { "type": "string", "description": "message_id to thread under" },
      "files": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["chat_id", "text"]
  }
}
```

### 1.3 react

```json
{
  "name": "react",
  "inputSchema": {
    "type": "object",
    "properties": {
      "chat_id": { "type": "string" },
      "message_id": { "type": "string" },
      "emoji": { "type": "string" }
    },
    "required": ["chat_id", "message_id", "emoji"]
  }
}
```

### 1.4 edit_message

```json
{
  "name": "edit_message",
  "inputSchema": {
    "type": "object",
    "properties": {
      "chat_id": { "type": "string" },
      "message_id": { "type": "string" },
      "text": { "type": "string" }
    },
    "required": ["chat_id", "message_id", "text"]
  }
}
```

### 1.5 get_bot_info

```json
{
  "name": "get_bot_info",
  "description": "Get bot username and status info.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

## 2. Message Queue Design

- In-memory array, max 100 entries
- FIFO: oldest messages dropped on overflow
- `get_messages` returns copy then clears
- Each entry: `{ chat_id, message_id, user, user_id, text, ts, image_path? }`

## 3. Access Control

- Read `~/.claude/channels/telegram/access.json`
- Only deliver messages from `allowFrom` user IDs
- Outbound tools check `allowFrom` before sending
- No pairing flow (simplified -- reuse existing allowlist)

## 4. Configuration

- Bot token from `~/.claude/channels/telegram/.env`
- Access from `~/.claude/channels/telegram/access.json`
- MCP registered in `~/.claude/settings.json` under `mcpServers`

## 5. Registration in settings.json

```json
{
  "mcpServers": {
    "telegram": {
      "command": "/Users/jypark/.bun/bin/bun",
      "args": ["run", "/Users/jypark/.claude/mcp/telegram-claude/server.ts"],
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
