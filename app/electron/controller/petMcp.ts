import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import SerialConnect from './serialPort'
import type { PetRequest } from './screenReadback'
import { petActions, playableActions, petScenes, petToys, petToyIds, petToyPhases, petFruitIds as fruits,
  petItems, toysForScene, petStateGeneration, petFoodStages } from '../../src/utils/petCatalog'

const seasons = ['spring', 'summer', 'autumn', 'winter'] as const
const sources = ['automatic', 'physical', 'mcp'] as const
const commands = { state: 0, mode: 1, feed: 2, action: 3, hour: 4, season: 5, scene: 6, toy: 7, interactToy: 11, placeToy: 13 }
// Older MCP clients used toy_factory for the room at USB scene index 1.
const sceneInput = z.preprocess(value => value === 'toy_factory' ? 'nursery' : value, z.enum(petScenes))
const toyForWireId = (id: number) => petToys.find(toy => toy.wireId === id)?.id ?? null

async function requestDevice(request: PetRequest, session?: string) {
  const reply = await SerialConnect.pet(request, session)
  if (reply.state !== 'ready') {
    const errors = {
      busy: '键盘正在传输数据，请稍后重试。',
      unsupported: '当前固件不支持这项桌宠功能，请升级键盘固件。',
      disconnected: 'MultiPad 未连接。',
      unavailable: '没有收到设备回复。修改操作可能已经生效，请先查询状态或事件。'
    }
    throw Object.assign(Error(errors[reply.state]), { state: reply.state })
  }
  if (reply.status !== 0) {
    if (reply.status === 4) {
      if ('command' in request && request.command === commands.feed) throw Error('当前场景已满或兔子正在忙，请先查询宠物状态。')
      if ('command' in request && request.command === commands.placeToy) throw Error('当前场景已有其他玩具，请先查看已放置的玩具。')
      throw Error('兔子正在处理水果或玩具，请稍后重试。')
    }
    if (reply.status === 5) throw Error('请先用 pet_set_mode 进入桌宠模式。')
    if ('command' in request && request.command === commands.hour) throw Error('键盘拒绝修改时间，请先关闭“跟随现实时间”。')
    if ('command' in request && [commands.toy, commands.placeToy, commands.interactToy].includes(request.command)) {
      throw Error('请确认玩具支持当前场景。再次互动前须先放下对应玩具。')
    }
    throw Error('键盘拒绝了此桌宠命令，请确认固件支持所选功能。')
  }
  return reply
}

async function command(command: number, value = 0) {
  const { payload, session } = await requestDevice({ command, value })
  const generation = petStateGeneration(payload)
  if (!generation) throw Error('桌宠状态格式不匹配。')
  const extended = generation >= 2
  const scene = extended ? petScenes[payload[16]] ?? null : null
  return {
    session,
    active: Boolean(payload[0]),
    action: payload[0] ? petActions[payload[1]] ?? null : null,
    positionX: payload[0] ? payload.readUInt16LE(2) : null,
    frames: payload.readUInt32LE(4),
    fruit: fruits[payload[8] - 1] ?? null,
    hour: payload[9],
    minute: generation >= 3 ? payload[28] : null,
    season: seasons[payload[10]],
    queuedFruit: payload[11],
    stats: extended ? { satiety: payload[12], sleepiness: payload[13], mood: payload[14], affection: payload[15] } : null,
    scene,
    activeToy: extended ? toyForWireId(payload[17]) : null,
    toyPhase: extended ? petToyPhases[payload[18]] ?? null : null,
    availableToys: toysForScene(scene, generation).map(toy => toy.id),
    keyBindings: generation >= 3 ? Array.from(payload.subarray(19, 27), slot =>
      petItems.find(item => item.itemId === slot)?.id ?? null) : null,
    followRealTime: generation >= 3 ? Boolean(payload[27] & 1) : null,
    bedtime: generation >= 3 ? Boolean(payload[27] & 2) : null,
    deployedToys: generation >= 3 ? { garden: toyForWireId(payload[29]), nursery: toyForWireId(payload[30]) } : null,
    toyDropProgress: generation >= 3 ? payload[31] : null,
    foods: generation >= 3 ? Array.from({ length: payload[32] }, (_, index) => {
      const i = 33 + index * 6
      return { fruit: fruits[payload[i] - 1], x: payload.readUInt16LE(i + 1),
        y: payload.readInt16LE(i + 3), stage: petFoodStages[payload[i + 5]] }
    }) : null
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
    case 2: return { ...base, type: 'action_changed', action: petActions[value], fruit: fruits[detail - 1] ?? null }
    case 3: return { ...base, type: 'fruit_queued', fruit: fruits[value - 1], queueDepth: detail }
    case 4: return { ...base, type: 'fruit_landed', fruit: fruits[value - 1] }
    case 5: return { ...base, type: 'fruit_eaten', fruit: fruits[value - 1] }
    case 6: return { ...base, type: 'hour_changed', hour: value, previousHour: detail }
    case 7: return { ...base, type: 'season_changed', season: seasons[value], previousSeason: seasons[detail] }
    case 8: return { ...base, type: 'key_pressed', key: value }
    case 9: return { ...base, type: 'snack', encoder: detail }
    case 10: return { ...base, type: 'scene_changed', scene: petScenes[value], previousScene: petScenes[detail] }
    case 11: return { ...base, type: 'toy_started', toy: toyForWireId(value) }
    case 12: return { ...base, type: 'toy_finished', toy: toyForWireId(value), interrupted: Boolean(detail) }
    case 13: return { ...base, type: 'toy_placed', toy: toyForWireId(value), scene: petScenes[detail] }
    case 14: return { ...base, type: 'toy_removed', toy: toyForWireId(value), scene: petScenes[detail] }
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
  const server = new McpServer({ name: 'multipad-pet', version: '1.2.0' })
  server.registerTool('pet_get_state', {
    description: '读取兔子的动作、位置、水果、时间、季节、场景、玩具和四项属性（0–100）。旧固件的扩展字段为 null。',
    annotations: { readOnlyHint: true }
  }, () => result(() => command(commands.state)))

  server.registerTool('pet_set_mode', {
    description: '进入桌宠模式，或者退出并恢复当前层的彩屏画面。',
    inputSchema: { enabled: z.boolean() }
  }, ({ enabled }) => result(() => command(commands.mode, Number(enabled))))

  server.registerTool('pet_play_action', {
    description: '播放指定动作。sleep 会去宝宝房的兔窝睡觉；在途时 action 仍为 walk，bedtime 为 true。idle 可叫醒兔子，投喂水果请用 pet_feed。',
    inputSchema: { action: z.enum(playableActions) }
  }, ({ action }) => result(() => command(commands.action, petActions.indexOf(action))))

  server.registerTool('pet_feed', {
    description: '投下一份水果。最多同时保留八份。兔子饱了会把水果留在地上，只有 fruit_eaten 事件表示吃完。',
    inputSchema: { fruit: z.enum(fruits) }
  }, ({ fruit }) => result(() => command(commands.feed, fruits.indexOf(fruit) + 1)))

  server.registerTool('pet_set_time', {
    description: '手动设置场景的整点时间，0–23。先在设置里关闭跟随现实时间。',
    inputSchema: { hour: z.number().int().min(0).max(23) }
  }, ({ hour }) => result(() => command(commands.hour, hour)))

  server.registerTool('pet_set_season', {
    description: '设置春、夏、秋或冬，切换当前场景的季节配色。',
    inputSchema: { season: z.enum(seasons) }
  }, ({ season }) => result(() => command(commands.season, seasons.indexOf(season))))

  server.registerTool('pet_set_scene', {
    description: '切换彩屏背景。garden 是花园，nursery 是有玩具和兔窝的宝宝房。',
    inputSchema: { scene: sceneInput }
  }, ({ scene }) => result(() => command(commands.scene, petScenes.indexOf(scene))))

  server.registerTool('pet_list_toys', {
    description: '列出当前场景的互动玩具。传 scene 可查询指定场景的玩具目录。',
    inputSchema: { scene: sceneInput.optional() },
    annotations: { readOnlyHint: true }
  }, ({ scene }) => result(async () => {
    // An explicit scene also supports browsing the app's catalogue without a keyboard.
    const pet = await command(commands.state).catch((error: unknown) => {
      if (scene && error instanceof Error && 'state' in error && error.state === 'disconnected') return null
      throw error
    })
    const selected = scene ?? pet?.scene ?? null
    const generation = !pet || pet.keyBindings ? 3 : pet.stats ? 2 : 1
    const toys = toysForScene(selected, generation).map(({ id, label, description }) => ({ id, label, description }))
    return { scene: selected, toys }
  }))

  server.registerTool('pet_use_toy', {
    description: '切换当前场景中的玩具。首次放下后兔子会去玩；再次选择同一玩具会收回，选择其他玩具会替换。旧版固件执行一次短暂互动。',
    inputSchema: { toy: z.enum(petToyIds) }
  }, ({ toy }) => result(() => command(commands.toy, petToys.find(entry => entry.id === toy)!.wireId)))

  server.registerTool('pet_place_toy', {
    description: '在当前场景的空位放下玩具。相同玩具已放置时保持原状；若已有其他玩具，返回忙。',
    inputSchema: { toy: z.enum(petToyIds) }
  }, ({ toy }) => result(() => command(commands.placeToy, petToys.find(entry => entry.id === toy)!.wireId)))

  server.registerTool('pet_interact_with_toy', {
    description: '让兔子和当前场景中已落地的玩具再玩一次，保留玩具的位置。',
    inputSchema: { toy: z.enum(petToyIds) }
  }, ({ toy }) => result(() => command(commands.interactToy, petToys.find(entry => entry.id === toy)!.wireId)))

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
