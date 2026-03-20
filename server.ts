#!/usr/bin/env bun
/**
 * Telegram MCP Server for Claude Code
 *
 * Custom MCP server that bypasses --channels org policy restriction.
 * Registered via mcpServers in settings.json instead of the blocked --channels flag.
 *
 * Key difference from official plugin:
 * - Official: uses notifications/claude/channel (push) -- requires --channels
 * - Custom: uses get_messages tool (pull) -- works as standard mcpServers
 *
 * Architecture:
 *   Telegram Bot API (long polling via grammy)
 *     -> inbound messages stored in memory queue
 *     -> Claude calls get_messages to retrieve them
 *     -> Claude calls reply/react/edit_message to respond
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Bot, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

// ── Configuration ──────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const MAX_QUEUE_SIZE = 100
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// ── Load .env ──────────────────────────────────────────────────────────────

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TOKEN) {
  process.stderr.write(
    `telegram-mcp: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// ── Access Control ─────────────────────────────────────────────────────────

type Access = {
  dmPolicy: string
  allowFrom: string[]
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>
  pending: Record<string, unknown>
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  replyToMode?: 'off' | 'first' | 'all'
}

function loadAccess(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      replyToMode: parsed.replyToMode,
    }
  } catch {
    return { dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }
  }
}

function isAllowedSender(userId: string): boolean {
  const access = loadAccess()
  return access.allowFrom.includes(userId)
}

function assertAllowedChat(chatId: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`chat ${chatId} is not in allowlist`)
}

// ── Security: prevent sending state files ──────────────────────────────────

function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ── Message Queue ──────────────────────────────────────────────────────────

type QueuedMessage = {
  chat_id: string
  message_id: string
  user: string
  user_id: string
  text: string
  ts: string
  image_path?: string
}

const messageQueue: QueuedMessage[] = []

function enqueueMessage(msg: QueuedMessage): void {
  messageQueue.push(msg)
  // Drop oldest if over limit
  while (messageQueue.length > MAX_QUEUE_SIZE) {
    messageQueue.shift()
  }
}

function dequeueMessages(limit?: number): QueuedMessage[] {
  const count = limit && limit > 0 ? Math.min(limit, messageQueue.length) : messageQueue.length
  return messageQueue.splice(0, count)
}

// ── Text Chunking ──────────────────────────────────────────────────────────

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Telegram Bot ───────────────────────────────────────────────────────────

const bot = new Bot(TOKEN)
let botUsername = ''

// ── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Telegram MCP Server -- use these tools to communicate via Telegram.',
      '',
      'Workflow:',
      '1. Call get_messages to check for new Telegram messages',
      '2. Process each message and call reply with the chat_id',
      '3. Optionally use react to add emoji reactions or edit_message to update sent messages',
      '',
      'Important:',
      '- Messages are queued in memory. Call get_messages periodically (e.g., via /loop) to check for new messages.',
      '- The reply tool sends to Telegram -- your normal text output does NOT reach the Telegram user.',
      '- Pass chat_id from the received message back to reply/react/edit_message.',
      '- Use reply_to (message_id) only when quoting a specific earlier message.',
      '- Files can be attached via the files parameter in reply (absolute paths).',
    ].join('\n'),
  },
)

// ── Tool Definitions ───────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_messages',
      description:
        'Get new messages from Telegram. Returns all queued inbound messages and clears the queue. Call this periodically to check for new messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Max number of messages to return. Default: all queued messages.',
          },
        },
      },
    },
    {
      name: 'reply',
      description:
        'Send a reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: {
            type: 'string',
            description: 'Message ID to thread under.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach. Images as photos, others as documents. Max 50MB each.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to a Telegram message. Telegram accepts a fixed whitelist of emoji.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description:
        'Edit a message the bot previously sent. Useful for progress updates.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
    {
      name: 'get_bot_info',
      description: 'Get the bot username and connection status.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}))

// ── Tool Handlers ──────────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      // ── get_messages ──
      case 'get_messages': {
        const limit = args.limit as number | undefined
        const messages = dequeueMessages(limit)
        const result = {
          messages,
          count: messages.length,
          queue_remaining: messageQueue.length,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
      }

      // ── reply ──
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []

        assertAllowedChat(chat_id)

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: number[] = []

        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null &&
            replyMode !== 'off' &&
            (replyMode === 'all' || i === 0)
          const sent = await bot.api.sendMessage(chat_id, chunks[i], {
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
          })
          sentIds.push(sent.message_id)
        }

        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = reply_to != null && replyMode !== 'off'
            ? { reply_parameters: { message_id: reply_to } }
            : undefined
          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chat_id, input, opts)
            sentIds.push(sent.message_id)
          } else {
            const sent = await bot.api.sendDocument(chat_id, input, opts)
            sentIds.push(sent.message_id)
          }
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      // ── react ──
      case 'react': {
        assertAllowedChat(args.chat_id as string)
        await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
          { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
        ])
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      // ── edit_message ──
      case 'edit_message': {
        assertAllowedChat(args.chat_id as string)
        const edited = await bot.api.editMessageText(
          args.chat_id as string,
          Number(args.message_id),
          args.text as string,
        )
        const id = typeof edited === 'object' ? edited.message_id : args.message_id
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }

      // ── get_bot_info ──
      case 'get_bot_info': {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              username: botUsername || '(not started yet)',
              queue_size: messageQueue.length,
              max_queue: MAX_QUEUE_SIZE,
              access: {
                allowFrom: loadAccess().allowFrom,
                dmPolicy: loadAccess().dmPolicy,
              },
            }, null, 2),
          }],
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ── Connect MCP transport ──────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// ── Telegram Bot Handlers ──────────────────────────────────────────────────

bot.on('message:text', async ctx => {
  const from = ctx.from
  if (!from) return

  const senderId = String(from.id)
  if (!isAllowedSender(senderId)) {
    process.stderr.write(`telegram-mcp: dropped message from non-allowed sender ${senderId}\n`)
    return
  }

  enqueueMessage({
    chat_id: String(ctx.chat.id),
    message_id: String(ctx.message.message_id),
    user: from.username ?? String(from.id),
    user_id: senderId,
    text: ctx.message.text,
    ts: new Date(ctx.message.date * 1000).toISOString(),
  })

  process.stderr.write(`telegram-mcp: queued message from @${from.username ?? senderId} (queue: ${messageQueue.length})\n`)
})

bot.on('message:photo', async ctx => {
  const from = ctx.from
  if (!from) return

  const senderId = String(from.id)
  if (!isAllowedSender(senderId)) return

  // Download the largest photo
  let imagePath: string | undefined
  const photos = ctx.message.photo
  const best = photos[photos.length - 1]
  try {
    const file = await ctx.api.getFile(best.file_id)
    if (file.file_path) {
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      imagePath = path
    }
  } catch (err) {
    process.stderr.write(`telegram-mcp: photo download failed: ${err}\n`)
  }

  enqueueMessage({
    chat_id: String(ctx.chat.id),
    message_id: String(ctx.message.message_id),
    user: from.username ?? String(from.id),
    user_id: senderId,
    text: ctx.message.caption ?? '(photo)',
    ts: new Date(ctx.message.date * 1000).toISOString(),
    image_path: imagePath,
  })

  process.stderr.write(`telegram-mcp: queued photo from @${from.username ?? senderId}\n`)
})

// Handle document messages (files)
bot.on('message:document', async ctx => {
  const from = ctx.from
  if (!from) return

  const senderId = String(from.id)
  if (!isAllowedSender(senderId)) return

  let filePath: string | undefined
  const doc = ctx.message.document
  try {
    const file = await ctx.api.getFile(doc.file_id)
    if (file.file_path) {
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = doc.file_name?.split('.').pop() ?? 'bin'
      const path = join(INBOX_DIR, `${Date.now()}-${doc.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      filePath = path
    }
  } catch (err) {
    process.stderr.write(`telegram-mcp: document download failed: ${err}\n`)
  }

  enqueueMessage({
    chat_id: String(ctx.chat.id),
    message_id: String(ctx.message.message_id),
    user: from.username ?? String(from.id),
    user_id: senderId,
    text: ctx.message.caption ?? `(document: ${doc.file_name ?? 'file'})`,
    ts: new Date(ctx.message.date * 1000).toISOString(),
    image_path: filePath,
  })
})

// ── Start Bot ──────────────────────────────────────────────────────────────

void bot.start({
  onStart: info => {
    botUsername = info.username
    process.stderr.write(`telegram-mcp: polling as @${info.username}\n`)
    process.stderr.write(`telegram-mcp: allowed users: ${loadAccess().allowFrom.join(', ')}\n`)
    process.stderr.write(`telegram-mcp: queue max: ${MAX_QUEUE_SIZE}\n`)
    process.stderr.write(`telegram-mcp: ready -- use get_messages tool to receive messages\n`)
  },
})
