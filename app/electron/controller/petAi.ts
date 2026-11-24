import { safeStorage } from 'electron'
import Store from 'electron-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createPetMcp } from './petMcp'
import { petActionLabels, petActions, playableActions, petScenes, petToyIds, petToyPhases, petToys, petFoodStages,
  petFruitIds as fruits, petFruitLabels as fruitLabel } from '../../src/utils/petCatalog'

const allowedTools = ['pet_play_action', 'pet_feed', 'pet_use_toy', 'pet_place_toy', 'pet_interact_with_toy'] as const
const settingsSchema = z.object({
  apiUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/),
  enabled: z.boolean()
})
const stat = z.number().int().min(0).max(100)
const stateSchema = z.object({
  session: z.string(), active: z.boolean(), action: z.string().nullable(), fruit: z.enum(fruits).nullable(),
  queuedFruit: z.number().int().nonnegative(), hour: z.number(), minute: z.number().nullable(),
  season: z.string(), bedtime: z.boolean().nullable(),
  stats: z.object({ satiety: stat, sleepiness: stat, mood: stat, affection: stat }).nullable(),
  scene: z.enum(petScenes).nullable(), activeToy: z.enum(petToyIds).nullable(),
  toyPhase: z.enum(petToyPhases).nullable(), availableToys: z.array(z.enum(petToyIds)),
  deployedToys: z.object({ garden: z.enum(petToyIds).nullable(), nursery: z.enum(petToyIds).nullable() }).nullable(),
  toyDropProgress: z.number().nullable(),
  foods: z.array(z.object({ fruit: z.enum(fruits), stage: z.enum(petFoodStages) })).nullable()
})
type PetState = z.infer<typeof stateSchema>
const usingToy = (pet: PetState) => !!pet.activeToy || pet.toyPhase === 'using' || pet.toyPhase === 'approaching'
const asleepInHutch = (pet: PetState) => pet.bedtime && pet.activeToy === 'rabbit_hutch' &&
  pet.toyPhase === 'using' && pet.action === 'sleep'
const busyWithToy = (pet: PetState) => usingToy(pet) && !asleepInHutch(pet)
const hasFood = (pet: PetState) => pet.foods ? pet.foods.length > 0 : !!(pet.fruit || pet.queuedFruit)
const canAutoFeed = (pet: PetState) => !hasFood(pet) && pet.stats?.satiety !== 100
const foodInProgress = (pet: PetState) => hasFood(pet) &&
  (pet.stats?.satiety !== 100 || !pet.foods || pet.foods.some(food => food.stage === 'eating'))

function toyChoice(pet: PetState) {
  if (!pet.deployedToys || !pet.scene) return { tool: 'pet_use_toy', toys: pet.availableToys } as const
  const toy = pet.deployedToys[pet.scene]
  if (!toy) return { tool: 'pet_place_toy', toys: pet.availableToys } as const
  return { tool: 'pet_interact_with_toy', toys: pet.toyDropProgress === 100 ? [toy] : [] } as const
}
const eventsSchema = z.object({
  cursor: z.string(), reset: z.boolean(), overrun: z.boolean(), hasMore: z.boolean(),
  events: z.array(z.object({
    sequence: z.number(), uptimeMs: z.number(), source: z.string(), type: z.string(),
    fruit: z.enum(fruits).nullish(), queueDepth: z.number().optional(), active: z.boolean().optional()
  }))
})
const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      tool_calls: z.array(z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.enum(allowedTools), arguments: z.string().max(2048)
        })
      })).optional().nullable()
    })
  })).min(1)
})

interface Settings { apiUrl: string; model: string; encryptedKey: string; enabled: boolean }
interface Status { phase: 'idle' | 'thinking' | 'queued' | 'landed' | 'eaten' | 'action' | 'error' | 'unconfirmed'; message: string; fruit?: string; sequence?: number; uptimeMs?: number }
interface Provider { endpoint: string; model: string; key: string }

let settingsStore: Store<{ settings: Settings }> | undefined
const store = () => settingsStore ??= new Store<{ settings: Settings }>({ name: 'pet-ai' })
const intervalMs = 60_000
const defaultUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const defaultModel = 'qwen3.8-flash'
let revision = 0
let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let status: Status = { phase: 'idle', message: '等待启用 AI 控制' }

function endpointFor(input: string) {
  const url = new URL(input)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw Error('请输入 HTTPS API 地址，或本机模型的 HTTP 地址')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions'
  return url.toString()
}

export function getPetAi() {
  const saved = store().get('settings')
  return { apiUrl: saved?.apiUrl ?? defaultUrl, model: saved?.model ?? defaultModel, enabled: saved?.enabled ?? false,
    hasKey: !!saved?.encryptedKey, running, status }
}

export function savePetAi(input: unknown) {
  const { apiUrl, model, apiKey, enabled } = settingsSchema.parse(input)
  const endpoint = endpointFor(apiUrl)
  const saved = store().get('settings')
  const encryptedKey = apiKey
    ? encryptKey(apiKey)
    : saved?.apiUrl === endpoint ? saved.encryptedKey : ''
  if (!encryptedKey) throw Error('请填写此 API 地址的 API Key')
  store().set('settings', { apiUrl: endpoint, model, encryptedKey, enabled })
  revision++
  if (!running) status = { phase: 'idle', message: enabled ? '等待下一次 AI 决策' : 'AI 控制已暂停' }
  schedule()
  return getPetAi()
}

function encryptKey(key: string) {
  if (!safeStorage.isEncryptionAvailable()) throw Error('Windows 密钥存储暂不可用')
  return safeStorage.encryptString(key).toString('base64')
}

function providerFor(settings: Settings): Provider {
  return {
    endpoint: settings.apiUrl, model: settings.model,
    key: safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'))
  }
}

async function withPetMcp<T>(task: (client: Client) => Promise<T>) {
  const server = createPetMcp()
  const client = new Client({ name: 'multipad-pet-ai', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return await task(client)
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
}

async function callPet(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content) ? result.content[0] : undefined
    throw Error(content?.type === 'text' ? content.text : '桌宠工具调用失败')
  }
  return result.structuredContent
}

async function decide(provider: Provider, client: Client, prompt: string, pet?: PetState) {
  const { tools } = await client.listTools()
  const sleeping = pet && asleepInHutch(pet)
  const actions = playableActions.filter(action => {
    if (sleeping) return action === 'idle'
    if (pet?.foods && pet.stats?.satiety === 100 && action === 'eat') return false
    return !!pet?.stats || petActions.indexOf(action) <= petActions.indexOf('blink')
  })
  const choice = pet && !sleeping ? toyChoice(pet) : undefined
  const toys = choice?.toys ?? []
  const offered = tools.filter(tool => (tool.name === 'pet_feed' && (!pet || canAutoFeed(pet))) ||
    (pet && tool.name === 'pet_play_action') || (toys.length && tool.name === choice?.tool)).map(tool => {
    const { $schema: _schema, ...parameters } = tool.inputSchema
    if (tool.name === 'pet_play_action' || tool.name === choice?.tool) {
      parameters.properties = tool.name === 'pet_play_action'
        ? { action: { type: 'string', enum: actions } } : { toy: { type: 'string', enum: toys } }
    }
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters } }
  })
  const response = await fetch(provider.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { Authorization: 'Bearer ' + provider.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model, stream: false, tool_choice: 'auto',
      messages: [
        { role: 'system', content: '你自主控制键盘上的宠物兔。根据给定状态最多调用一个工具一次。只使用给定工具；想保持当前行为时无需调用。投喂只排队，进食结束以设备事件为准。' },
        { role: 'user', content: prompt }
      ],
      tools: offered
    })
  }).catch(() => { throw Error('无法连接模型 API，或请求超时') })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 && new URL(provider.endpoint).hostname === new URL(defaultUrl).hostname) {
      throw Error('Token Plan 返回 401，请使用对应套餐的专用 API Key')
    }
    throw Error('模型 API 返回 HTTP ' + response.status + '，请检查地址、模型和 Key')
  }
  const parsed = completionSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw Error('模型未返回有效的工具调用格式')
  const calls = parsed.data.choices[0].message.tool_calls ?? []
  if (calls.length > 1) throw Error('模型一次请求了多个动作，本轮已跳过')
  const call = calls[0]?.function
  if (!call) return undefined
  if (!offered.some(tool => tool.function.name === call.name)) throw Error('模型选择的工具当前不可用')
  const args: unknown = JSON.parse(call.arguments)
  if (call.name === 'pet_feed') {
    return { name: call.name, fruit: z.object({ fruit: z.enum(fruits) }).strict().parse(args).fruit } as const
  }
  if (call.name === 'pet_use_toy' || call.name === 'pet_place_toy' || call.name === 'pet_interact_with_toy') {
    const { toy } = z.object({ toy: z.enum(petToyIds) }).strict().parse(args)
    if (!toys.includes(toy)) throw Error('模型选择的玩具不在当前场景中')
    return { name: call.name, toy } as const
  }
  const { action } = z.object({ action: z.enum(playableActions) }).strict().parse(args)
  if (!actions.includes(action)) throw Error('当前固件不支持所选动作')
  return { name: call.name, action } as const
}

const readState = async (client: Client) => stateSchema.parse(await callPet(client, 'pet_get_state'))
const readEvents = async (client: Client, cursor?: string) =>
  eventsSchema.parse(await callPet(client, 'pet_get_events', cursor ? { cursor } : {}))

async function feedAndObserve(client: Client, fruit: typeof fruits[number], expectedSession: string,
  stillEnabled: () => boolean, automatic: boolean) {
  let page = await readEvents(client)
  for (let i = 0; page.hasMore && i < 5; i++) page = await readEvents(client, page.cursor)
  if (page.hasMore) throw Error('桌宠事件正在快速变化，请稍后重试')
  let cursor = page.cursor
  const before = await readState(client)
  if (before.session !== expectedSession) throw Error('键盘连接已改变')
  if (!before.active) throw Error('请先让键盘进入养宠模式')
  if (hasFood(before)) throw Error('已有水果在场景中，等待兔子取食')
  if (automatic && !canAutoFeed(before)) {
    status = { phase: 'idle', message: '兔子已经吃饱了' }
    return
  }
  if (busyWithToy(before)) throw Error('兔子正在使用玩具')
  if (!cursor.startsWith(before.session + ':')) throw Error('键盘连接已改变')
  if (!stillEnabled()) return
  const label = fruitLabel[fruit]
  const receipt = stateSchema.parse(await callPet(client, 'pet_feed', { fruit }))
  status = { phase: 'queued', message: label + '已排队', fruit }
  let queued = false
  const deadline = Date.now() + 20_000
  try {
    if (receipt.session !== before.session || (receipt.foods
      ? receipt.foods.length !== 1 || receipt.foods[0].fruit !== fruit
      : receipt.queuedFruit !== 1)) throw Error()
    while (Date.now() < deadline) {
      try {
        page = await readEvents(client, cursor)
      } catch {
        await delay(300)
        continue
      }
      if (page.reset || page.overrun) break
      cursor = page.cursor
      for (const event of page.events) {
        if ((event.type === 'mode_changed' && !event.active) || event.type === 'scene_changed') throw Error()
        if (!queued && event.type === 'fruit_queued') {
          if (event.source !== 'mcp' || event.fruit !== fruit || event.queueDepth !== 1) throw Error()
          queued = true
        } else if (queued && event.fruit === fruit && event.source === 'mcp') {
          // Events have no per-fruit serial number. Two identical MCP feeds cannot be attributed safely.
          if (event.type === 'fruit_queued') throw Error()
          if (event.type === 'fruit_landed') {
            status = { phase: 'landed', message: label + '已落地，等待兔子取食', fruit }
            if (receipt.foods && receipt.stats?.satiety === 100) return
          }
          if (event.type === 'fruit_eaten') {
            status = { phase: 'eaten', message: '兔子已吃完' + label, fruit, sequence: event.sequence, uptimeMs: event.uptimeMs }
            return
          }
        }
      }
      if (!page.hasMore) await delay(300)
    }
  } catch {
    // An accepted write is never repeated while waiting for confirmation.
  }
  status = { phase: 'unconfirmed', message: label + '已排队，未收到可确认的吃完事件', fruit }
}

async function run(kind: 'auto' | 'connection' | 'feed') {
  if (running) throw Error('AI 正在处理上一轮')
  const saved = store().get('settings')
  if (!saved?.encryptedKey) throw Error('请先保存模型配置')
  if (kind === 'auto' && !saved.enabled) return getPetAi()
  const startingRevision = revision
  running = true
  try {
    await withPetMcp(async client => {
      const stillEnabled = () => startingRevision === revision
      const pet = kind === 'connection' ? undefined : await readState(client)
      if (pet && !pet.active) {
        if (kind === 'feed') throw Error('请先让键盘进入养宠模式')
        status = { phase: 'idle', message: '等待键盘进入养宠模式' }
        return
      }
      if (pet && (kind === 'feed' ? hasFood(pet) : foodInProgress(pet))) {
        if (kind === 'feed') throw Error('已有水果在场景中，等待兔子取食')
        status = { phase: 'idle', message: '等待兔子取食场景里的水果' }
        return
      }
      if (pet && busyWithToy(pet)) {
        if (kind === 'feed') throw Error('请等兔子使用完玩具再测试投喂')
        status = { phase: 'idle', message: '等待兔子使用完玩具' }
        return
      }
      status = { phase: 'thinking', message: kind === 'connection' ? '正在测试模型工具调用' : 'AI 正在选择兔子的动作' }
      const { active: _active, session: _session, ...scene } = pet ?? { active: false, session: '' }
      const request = kind === 'auto'
        ? '当前宠物状态：' + JSON.stringify(scene) +
          '。四项属性范围 0–100。饱食度低时可投喂，困意高时可睡觉。参考心情和好感度，在清醒时选自然动作或玩具。兔子在窝里熟睡时可保持原状，休息充分时可用 idle 叫醒。'
        : '这是 MultiPad 的投喂测试，请调用 pet_feed，参数 fruit 为 apple。'
      const decision = await decide(providerFor(saved), client, request, kind === 'auto' ? pet : undefined)
      if (!stillEnabled()) {
        status = { phase: 'idle', message: '模型设置已更新，本轮没有执行动作' }
        return
      }
      if (kind !== 'auto' && (decision?.name !== 'pet_feed' || decision.fruit !== 'apple')) {
        throw Error('模型没有发出预期的苹果投喂调用')
      }
      if (kind === 'connection') {
        status = { phase: 'idle', message: '模型连接正常，已验证工具调用' }
      } else if (pet && decision?.name === 'pet_feed') {
        await feedAndObserve(client, decision.fruit, pet.session, stillEnabled, kind === 'auto')
      } else if (pet && decision) {
        const fresh = await readState(client)
        if (fresh.session !== pet.session || !fresh.active || foodInProgress(fresh) || busyWithToy(fresh) ||
          fresh.scene !== pet.scene || fresh.bedtime !== pet.bedtime || !stillEnabled()) {
          status = { phase: 'idle', message: '兔子状态已改变，等待下次决策' }
          return
        }
        if (decision.name !== 'pet_play_action') {
          const choice = toyChoice(fresh)
          if (decision.name !== choice.tool || !choice.toys.includes(decision.toy)) throw Error('场景中的玩具已改变')
          const receipt = stateSchema.parse(await callPet(client, decision.name, { toy: decision.toy }))
          const placing = decision.name === 'pet_place_toy'
          const accepted = placing ? receipt.scene && receipt.deployedToys?.[receipt.scene] === decision.toy :
            receipt.activeToy === decision.toy && usingToy(receipt)
          status = receipt.session === fresh.session && accepted
            ? { phase: 'action', message: (placing ? 'AI 放下了' : 'AI 让兔子去使用') + petToys.find(toy => toy.id === decision.toy)!.label }
            : { phase: 'unconfirmed', message: '键盘未确认本次玩具操作' }
          return
        }
        const receipt = stateSchema.parse(await callPet(client, 'pet_play_action', { action: decision.action }))
        const headingToBed = decision.action === 'sleep' && receipt.bedtime && receipt.activeToy === 'rabbit_hutch' &&
          receipt.toyPhase === 'approaching'
        if (receipt.session !== fresh.session || (receipt.action !== decision.action && !headingToBed)) {
          status = { phase: 'unconfirmed', message: '未能确认兔子已开始所选动作' }
          return
        }
        status = { phase: 'action', message: headingToBed ? 'AI 让兔子回窝睡觉' : 'AI 让兔子' + petActionLabels[decision.action] }
      } else {
        status = { phase: 'idle', message: 'AI 让兔子保持当前状态' }
      }
    })
  } catch (error) {
    status = { phase: 'error', message: error instanceof z.ZodError ? '模型或设备返回的参数格式不正确'
      : error instanceof Error ? error.message : 'AI 控制失败' }
  } finally {
    running = false
    schedule(intervalMs)
  }
  return getPetAi()
}

export function testPetAi(kind: 'connection' | 'feed') {
  return run(kind)
}

function schedule(wait = 1500) {
  clearTimeout(timer)
  if (store().get('settings')?.enabled) {
    timer = setTimeout(() => {
      if (running) schedule(intervalMs)
      else void run('auto').catch(() => schedule(intervalMs))
    }, wait)
  }
}

export function startPetAi() { schedule() }
export function stopPetAi() {
  revision++
  clearTimeout(timer)
}
