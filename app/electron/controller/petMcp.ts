import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import SerialConnect from './serialPort'
import type { PetRequest } from './screenReadback'

const actions = ['idle', 'walk', 'sleep', 'eat', 'fall', 'fetch', 'run', 'jump', 'daydream', 'flee', 'blink'] as const
const playable = ['idle', 'blink', 'walk', 'run', 'jump', 'sleep', 'daydream', 'eat', 'flee'] as const
const fruits = ['apple', 'banana', 'orange', 'grape', 'strawberry', 'pear', 'cherry', 'watermelon'] as const
const seasons = ['spring', 'summer', 'autumn', 'winter'] as const
const sources = ['automatic', 'physical', 'mcp'] as const
const commands = { state: 0, mode: 1, feed: 2, action: 3, hour: 4, season: 5 }

async function requestDevice(request: PetRequest, session?: string) {
  const reply = await SerialConnect.pet(request, session)
  if (reply.state !== 'ready') {
    const errors = {
      busy: '键盘正在传输数据，请稍后重试。',
      unsupported: '当前固件不支持桌宠 MCP。',
      disconnected: 'MultiPad 未连接。',
      unavailable: '没有收到设备回复。修改操作可能已经生效，请先查询状态或事件。'
    }
    throw Error(errors[reply.state])
  }
  if (reply.status !== 0) {
    throw Error(reply.status === 4 ? '投喂队列已满，或兔子正在处理投喂。' :
      reply.status === 5 ? '请先用 pet_set_mode 进入桌宠模式。' : '键盘拒绝了此桌宠命令。')
  }
  return reply
}

async function command(command: number, value = 0) {
  const { payload, session } = await requestDevice({ command, value })
  if (payload.length !== 12) throw Error('桌宠状态格式不匹配。')
  return {
    session,
    active: Boolean(payload[0]),
    action: payload[0] ? actions[payload[1]] : null,
    positionX: payload[0] ? payload.readUInt16LE(2) : null,
    frames: payload.readUInt32LE(4),
    fruit: fruits[payload[8] - 1] ?? null,
    hour: payload[9],
    season: seasons[payload[10]],
    queuedFruit: payload[11]
  }
}

function decodeEvent(payload: Buffer, offset: number) {
  const value = payload[offset + 9]
  const detail = payload[offset + 11]
  const base = {
    sequence: payload.readUInt32LE(offset),
    uptimeMs: payload.readUInt32LE(offset + 4),
    source: sources[payload[offset + 10]]
  }
  switch (payload[offset + 8]) {
    case 1: return { ...base, type: 'mode_changed', active: Boolean(value) }
    case 2: return { ...base, type: 'action_changed', action: actions[value], fruit: fruits[detail - 1] ?? null }
    case 3: return { ...base, type: 'fruit_queued', fruit: fruits[value - 1], queueDepth: detail }
    case 4: return { ...base, type: 'fruit_landed', fruit: fruits[value - 1] }
    case 5: return { ...base, type: 'fruit_eaten', fruit: fruits[value - 1] }
    case 6: return { ...base, type: 'hour_changed', hour: value, previousHour: detail }
    case 7: return { ...base, type: 'season_changed', season: seasons[value], previousSeason: seasons[detail] }
    case 8: return { ...base, type: 'key_pressed', key: value }
    case 9: return { ...base, type: 'snack', encoder: detail }
    default: return { ...base, type: 'unknown', value, detail }
  }
}

async function readEvents(cursor?: string) {
  const [oldSession, offset] = cursor?.split(':') ?? []
  const after = offset ? Number(offset) : 0
  const { payload, session, reset } = await requestDevice({ after }, oldSession)
  if (!payload.length || (payload.length - 1) % 12 !== 0 || !session) throw Error('桌宠事件格式不匹配。')
  const events = []
  for (let i = 1; i < payload.length; i += 12) events.push(decodeEvent(payload, i))
  const overrun = Boolean(payload[0] & 1)
  const next = events.at(-1)?.sequence ?? (reset || overrun ? 0 : after)
  return { cursor: session + ':' + next, reset: Boolean(reset), overrun, hasMore: Boolean(payload[0] & 2), events }
}

async function result(run: () => Promise<Record<string, unknown>>) {
  try {
    const data = await run()
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data }
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
  }
}

export function createPetMcp() {
  const server = new McpServer({ name: 'multipad-pet', version: '1.0.0' })
  server.registerTool('pet_get_state', {
    description: '读取键盘桌宠当前模式、动作、位置、水果、场景时间与季节。',
    annotations: { readOnlyHint: true }
  }, () => result(() => command(commands.state)))

  server.registerTool('pet_set_mode', {
    description: '进入桌宠模式，或者退出并恢复当前层的彩屏画面。',
    inputSchema: { enabled: z.boolean() }
  }, ({ enabled }) => result(() => command(commands.mode, Number(enabled))))

  server.registerTool('pet_play_action', {
    description: '播放指定动作。idle 可叫醒睡着的兔子，eat 只播放进食演出，投喂水果请用 pet_feed。',
    inputSchema: { action: z.enum(playable) }
  }, ({ action }) => result(() => command(commands.action, actions.indexOf(action))))

  server.registerTool('pet_feed', {
    description: '投喂一份水果。水果会从屏幕上方落下，兔子随后走过去吃。',
    inputSchema: { fruit: z.enum(fruits) }
  }, ({ fruit }) => result(() => command(commands.feed, fruits.indexOf(fruit) + 1)))

  server.registerTool('pet_set_time', {
    description: '设置花园的整点时间，0–23。此时间只用于彩屏场景。',
    inputSchema: { hour: z.number().int().min(0).max(23) }
  }, ({ hour }) => result(() => command(commands.hour, hour)))

  server.registerTool('pet_set_season', {
    description: '设置春、夏、秋或冬，立即切换花园配色。',
    inputSchema: { season: z.enum(seasons) }
  }, ({ season }) => result(() => command(commands.season, seasons.indexOf(season))))

  server.registerTool('pet_get_events', {
    description: '读取已发生的桌宠事件。后续调用传入上次响应的 cursor。包括实体投喂键、旋钮改动和自动动作。',
    inputSchema: {
      cursor: z.string().regex(/^[0-9a-f-]{36}:\d{1,10}$/i)
        .refine(value => Number(value.split(':')[1]) <= 0xffffffff).optional()
    },
    annotations: { readOnlyHint: true }
  }, ({ cursor }) => result(() => readEvents(cursor)))
  return server
}

export function startPetMcp() {
  const token = process.env.MULTIPAD_PET_MCP_TOKEN
  if (!token) return
  if (!/^[\x21-\x7e]{16,128}$/.test(token)) throw Error('MULTIPAD_PET_MCP_TOKEN 需要 16–128 个非空格 ASCII 字符')
  const port = Number(process.env.MULTIPAD_PET_MCP_PORT ?? 18775)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('无效的 MULTIPAD_PET_MCP_PORT')
  const host = '127.0.0.1'
  const authority = host + ':' + port
  const expected = createHash('sha256').update('Bearer ' + token).digest()
  const http = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.host !== authority || request.headers.origin !== undefined) {
      response.writeHead(403).end()
      return
    }
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest()
    if (!timingSafeEqual(expected, supplied)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }

    const server = createPetMcp()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 8192
    })
    response.once('close', () => { void server.close().catch(() => {}) })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      console.error('MultiPad MCP request failed', error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  http.on('error', error => console.error('MultiPad MCP could not listen', error))
  http.listen(port, host)
  return http
}
