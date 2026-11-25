import { safeStorage } from 'electron'
import Store from 'electron-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setInterval as pollInterval, clearInterval as stopPolling } from 'node:timers'
import { z } from 'zod'
import { createPetMcp, rabbitSteps, readPetEvents } from './petMcp'
import { petCareGuide } from './petCareGuide'
import { defaultRabbitPersonality, personalityLimit } from '../../src/utils/petPersonality'
import { petActionLabels, petActions, playableActions, petScenes, petToyIds, petToys, petToyPhases, petRoomItems, petFoodStages, petHeadGestures,
  petFruitIds as fruits, petFruitLabels as fruitLabel } from '../../src/utils/petCatalog'

const settingsSchema = z.object({
  apiUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/),
  enabled: z.boolean(),
  personality: z.string().trim().max(personalityLimit).optional()
})
const stat = z.number().int().min(0).max(100)
const stateSchema = z.object({
  session: z.string(), active: z.boolean(), action: z.string().nullable(), fruit: z.enum(fruits).nullable(),
  generation: z.number().int(), positionX: z.number().nullable(), positionY: z.number().nullable(),
  followRealTime: z.boolean().nullable(),
  queuedFruit: z.number().int().nonnegative(), hour: z.number(), minute: z.number().nullable(),
  season: z.string(), bedtime: z.boolean().nullable(),
  stats: z.object({ satiety: stat, energy: stat, mood: stat, affection: stat }).nullable(),
  scene: z.enum(petScenes).nullable(), activeToy: z.enum(petToyIds).nullable(),
  activeDecoration: z.enum(['rabbit_hutch','nursery_table']).nullable(), decorationPhase: z.enum(petToyPhases).nullable(),
  headPet: z.object({ remainingMs: z.number().int().min(0).max(1200), gesture: z.enum(petHeadGestures).nullable() }).passthrough().nullable(),
  hutchPosition: z.object({ x: z.number(), y: z.number() }).nullable(),
  toyPhase: z.enum(petToyPhases).nullable(), availableToys: z.array(z.enum(petToyIds)),
  deployedToys: z.object({ garden: z.enum(petToyIds).nullable(), nursery: z.enum(petToyIds).nullable() }).nullable(),
  toyDropProgress: z.number().nullable(),
  foods: z.array(z.object({ fruit: z.enum(fruits), x: z.number(), y: z.number(), stage: z.enum(petFoodStages) })).nullable(),
  automaticBehaviors: z.array(z.string()).optional(),
  availableNow: z.object({ actions: z.array(z.enum(playableActions)), careNote: z.string() }).optional()
}).passthrough()
type PetState = z.infer<typeof stateSchema>
const usingToy = (pet: PetState) => !!pet.activeToy || pet.toyPhase === 'using' || pet.toyPhase === 'approaching'
const hutchPhase = (pet: PetState) => pet.activeDecoration === 'rabbit_hutch' ? pet.decorationPhase :
  pet.activeToy === 'rabbit_hutch' ? pet.toyPhase : null
const asleepInHutch = (pet: PetState) => pet.bedtime && hutchPhase(pet) === 'using' && pet.action === 'sleep'
const busyWithToy = (pet: PetState) => (usingToy(pet) || !!pet.activeDecoration) && !asleepInHutch(pet)
const hasFood = (pet: PetState) => pet.foods ? pet.foods.length > 0 : !!(pet.fruit || pet.queuedFruit)
const eventsSchema = z.object({
  cursor: z.string(), reset: z.boolean(), overrun: z.boolean(), hasMore: z.boolean(),
  events: z.array(z.object({
    sequence: z.number(), uptimeMs: z.number(), source: z.string(), type: z.string(),
    fruit: z.enum(fruits).nullish(), queueDepth: z.number().optional(), active: z.boolean().optional(),
    action: z.enum(petActions).optional(), scene: z.enum(petScenes).optional(), key: z.number().optional(),
    item: z.string().nullable().optional(), toy: z.enum(petToyIds).nullable().optional(),
    decoration: z.enum(['rabbit_hutch','nursery_table']).nullable().optional(), interrupted: z.boolean().optional(),
    gesture: z.enum(petHeadGestures).optional(), encoder: z.number().optional()
  }).passthrough())
})
const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      tool_calls: z.array(z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.literal('pet_perform_sequence'), arguments: z.string().max(2048)
        })
      })).optional().nullable()
    })
  })).min(1)
})

interface Settings { apiUrl: string; model: string; encryptedKey: string; enabled: boolean; personality?: string }
interface DecisionStep { label: string; index: number; total: number; next?: string }
interface Status { step?: DecisionStep; lastDecision?: string; phase: 'idle' | 'thinking' | 'action' | 'error'; message: string }
interface Provider { endpoint: string; model: string; key: string }

let settingsStore: Store<{ settings: Settings }> | undefined
const store = () => settingsStore ??= new Store<{ settings: Settings }>({ name: 'pet-ai' })
const intervalMs = 60_000
const defaultUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const defaultModel = 'qwen3.8-flash'
let revision = 0
let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let status: Status = { phase: 'idle', message: '等待下一次决策' }

let observedSession: string | null | undefined
type OwnerInteraction =
  | { type: 'head_petted' }
  | { type: 'fruit_queued'; fruit: typeof fruits[number] }
  | { type: 'toy_placed'; toy: 'carrot_toy' }
interface Reaction { events: OwnerInteraction[]; due: number; since: number; session: string }
let reaction: Reaction | undefined
let stopEventWatch: (() => void) | undefined
let nextDecisionAt: number | undefined
let requestAbort: AbortController | undefined
let autoRunning = false
let stepLabels: string[] = []
let activitySession: string | undefined
let activityVersion = 0
let activityListener: ((activity: ReturnType<typeof getPetAiActivity>) => void) | undefined

export function getPetAiActivity() {
  return { version: activityVersion, enabled: !!store().get('settings')?.enabled, session: activitySession, phase: status.phase, message: status.message, step: status.step, lastDecision: status.lastDecision, nextDecisionAt }
}

function setStatus(next: Status) {
  status = next
  publishActivity()
}

function publishActivity() {
  activityVersion++
  activityListener?.(getPetAiActivity())
}

function behaviorLabel(name: string): string {
  return petActionLabels[name as keyof typeof petActionLabels] ?? name
}

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
    personality: saved?.personality || defaultRabbitPersonality,
    hasKey: !!saved?.encryptedKey, running, status }
}

export function savePetAi(input: unknown) {
  const { apiUrl, model, apiKey, enabled, personality } = settingsSchema.parse(input)
  const endpoint = endpointFor(apiUrl)
  const saved = store().get('settings')
  const encryptedKey = apiKey
    ? encryptKey(apiKey)
    : saved?.apiUrl === endpoint ? saved.encryptedKey : ''
  if (!encryptedKey && (enabled || saved?.encryptedKey)) throw Error('请填写此 API 地址的 API Key')
  store().set('settings', { apiUrl: endpoint, model, encryptedKey, enabled,
    personality: (personality ?? saved?.personality) || defaultRabbitPersonality })
  revision++
  requestAbort?.abort()
  activitySession = undefined
  reaction = undefined
  watchOwnerEvents(enabled ? observedSession : null)
  setStatus({ phase: 'idle', message: enabled ? '等待下一次 AI 决策' : 'AI 控制已暂停' })
  schedule(observedSession ? 200 : 1500)
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
  const started = revision
  const server = createPetMcp(() => started === revision, (behavior, index, total) => {
    if (started !== revision) return
    const label = behaviorLabel(behavior)
    setStatus({ phase: 'action', message: '第 ' + index + '/' + total + ' 步已接收 · ' + label,
      step: { label, index, total, next: stepLabels[index] } })
  }, 'rabbit')
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

async function callPet(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const result = await client.callTool({ name, arguments: args }, undefined, { signal })
  if (result.isError || !result.structuredContent) {
    const content = Array.isArray(result.content) ? result.content[0] : undefined
    throw Error(content?.type === 'text' ? content.text : '桌宠工具调用失败')
  }
  return result.structuredContent
}

const rabbitRole = [
  '你通过动作扮演 MultiPad 键盘上的垂耳兔。主人从屏幕观察你的行为。用 pet_perform_sequence 安排一到六步动作，每步可设置 waitMs，例如先眨眼，过 500 毫秒再跳。适合继续当前行为时返回空工具调用，省略文字。',
  '第一步只从 observation.state.automaticBehaviors 选择；若为空或想维持现状，返回空工具调用。后续步骤可预期前序动作的结果。等待时间计在对应动作之前。',
  '四项属性均为 0–100。satiety 越低越饿，energy 越高越有精神，mood 是当下心情，affection 是对主人的好感。饱食度达到90停止自动进食，精神值不高于75才睡，恢复到95时可以醒来。心情达到90或精神值不高于15不主动玩玩具，好感达到90不靠凝视刷好感。根据四项数值、当前活动和最近发生的事一起判断，避免每轮重复同一动作。',
  '你只控制兔子的身体。主人负责投喂、摆放道具和切换场景。主人投下水果或玩具后，可用眨眼、跳跃等动作回应，也可以等待键盘处理取食或玩耍。eat 仅播放咀嚼动画。',
  'sleep 会回兔窝持续睡觉，兔窝小憩是短休。熟睡且仍困时可以继续睡，休息充分时可用 idle 醒来。胡萝卜玩具和兔窝装饰相互独立，完成玩耍才有属性收益。',
  '观测取自键盘。physical 表示实体操作，automatic 表示固件行为，mcp 可来自软件、外部客户端或你之前的动作。尊重主人刚投放的食物和玩具。字段为 null 或事件不完整时按已知事实行动。',
  'head_petted 是主人对你的摸头，physical 来自实体大旋钮，mcp 来自软件模拟。你可以继续享受抚摸，也能在合适时看向主人。',
  'observation.ownerInteractions 是本轮触发原因。结合主人刚做的事及最新状态决定兔子接下来的反应。连续抚摸是一轮互动，已经在吃或玩时可以让它继续。',
  '角色性格决定动作偏好，实际工具、参数和当前设备状态决定能执行的行为。'
].join('\n')

async function decide(provider: Provider, client: Client, observation: string | object, pet?: PetState, personality?: string, controller = new AbortController()) {
  const { tools } = await client.listTools()
  const selected = tools.find(t => t.name === 'pet_perform_sequence')
  if (!selected) throw Error('缺少宠物动作工具')
  const { $schema: _schema, ...parameters } = selected.inputSchema
  const description = pet?.automaticBehaviors
    ? selected.description + ' 当前第一步可选：' + (pet.automaticBehaviors.join('、') || '无，维持当前状态')
    : selected.description
  const offered = [{type: 'function', function: {name: selected.name, description, parameters}}]
  const timeout = AbortSignal.timeout(75_000)
  const onTimeout = () => controller.abort()
  timeout.addEventListener('abort', onTimeout, { once: true })
  let body: unknown
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + provider.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model, stream: false, tool_choice: 'auto',
        messages: [
          { role: 'system', content: pet ? rabbitRole : '这是键盘宠物的工具调用诊断。只生成指定工具调用一次，省略文字。' },
          { role: 'user', content: typeof observation === 'string' ? observation :
            JSON.stringify({ personality: personality || defaultRabbitPersonality, observation }) }
        ],
        tools: offered
      })
    }).catch(() => { throw Error(timeout.aborted ? '模型在 75 秒内未回复' : '无法连接模型 API，请检查网络或代理') })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 && new URL(provider.endpoint).hostname === new URL(defaultUrl).hostname) {
        throw Error('Token Plan 返回 401，请使用对应套餐的专用 API Key')
      }
      throw Error('模型 API 返回 HTTP ' + response.status + '，请检查地址、模型和 Key')
    }
    body = await response.json().catch(() => undefined)
  } finally {
    timeout.removeEventListener('abort', onTimeout)
  }
  const parsed = completionSchema.safeParse(body)
  if (!parsed.success) throw Error('模型未返回有效的工具调用格式')
  const calls = parsed.data.choices[0].message.tool_calls ?? []
  if (calls.length > 1) throw Error('模型一次请求了多个动作，本轮已跳过')
  const call = calls[0]?.function
  if (!call) return undefined
  if (!offered.some(tool => tool.function.name === call.name)) throw Error('模型选择的工具当前不可用')
  const args: unknown = JSON.parse(call.arguments)
  const plan = z.object({ steps: rabbitSteps, session: z.string().optional() }).strict().parse(args)
  return { name: 'pet_perform_sequence', steps: plan.steps } as const
}

const readState = async (client: Client) => stateSchema.parse(await callPet(client, 'pet_get_state'))
const readEvents = async (client: Client, cursor?: string) =>
  eventsSchema.parse(await callPet(client, 'pet_get_events', cursor ? { cursor } : {}))

let previousPlan: { session: string; accepted?: unknown; stoppedBefore?: unknown } | undefined
async function observeRecentEvents(client: Client, session: string) {
  const prefix = session + ':'
  let cursor: string | undefined
  const recent: z.infer<typeof eventsSchema>['events'] = []
  let partial = false
  try {
    // The firmware ring holds 64 entries, sent in pages of up to 16.
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const page = await readEvents(client, cursor)
      if (!page.cursor.startsWith(prefix) || page.reset) return { partial: true, events: [] }
      partial ||= page.overrun
      recent.push(...page.events)
      cursor = page.cursor
      if (!page.hasMore) break
      if (pageIndex === 3) partial = true
    }
    return { partial, events: recent }
  } catch {
    return { partial: true, events: recent }
  }
}

async function run(kind: 'auto' | 'connection' | 'blink') {
  if (running) throw Error('AI 正在处理上一轮')
  const saved = store().get('settings')
  if (!saved?.encryptedKey) throw Error('请先保存模型配置')
  if (kind === 'auto' && !saved.enabled) return getPetAi()
  const trigger = kind === 'auto' ? reaction : undefined
  let deferred = false
  const startingRevision = revision
  running = true
  autoRunning = kind === 'auto'
  nextDecisionAt = undefined
  clearTimeout(timer)
  requestAbort = new AbortController()
  if (!trigger) setStatus({ phase: 'thinking', message: kind === 'connection' ? '正在测试模型连接' : '正在读取键盘实况' })
  try {
    await withPetMcp(async client => {
      const stillEnabled = () => startingRevision === revision
      const pet = kind === 'connection' ? undefined : await readState(client)
      if (!stillEnabled()) return
      activitySession = pet?.session
      if (pet && !pet.active) {
        if (kind === 'blink') throw Error('请先让键盘进入养宠模式')
        setStatus({ phase: 'idle', message: '等待键盘进入养宠模式' })
        return
      }
      if (trigger && pet && trigger.session !== pet.session) return
      if (trigger && pet) {
        const touchRemaining = trigger.events.some(e => e.type === 'head_petted') ? pet.headPet?.remainingMs ?? 0 : 0
        const busy = !pet.automaticBehaviors?.length && (hasFood(pet) || busyWithToy(pet))
        const dropping = trigger.events.some(e => e.type === 'toy_placed') && pet.toyDropProgress !== null && pet.toyDropProgress < 100
        if (touchRemaining || ((busy || dropping) && Date.now() - trigger.since < 12_000)) {
          trigger.due = Date.now() + (touchRemaining ? Math.min(touchRemaining + 50, 700) : 450)
          deferred = true
          setStatus({ phase: 'idle', message: touchRemaining ? '等主人摸完头' : '等兔子完成眼前的互动' })
          return
        }
      }
      if (kind === 'blink' && !pet?.automaticBehaviors?.includes('blink')) throw Error('请等兔子空闲时再测试眨眼')
      setStatus({ phase: 'thinking', message: kind === 'connection' ? '正在测试模型工具调用' : trigger ? 'AI 正在回应' + interactionLabel(trigger.events.at(-1)!) : 'AI 正在选择兔子的动作' })
      const { session: _session, ...observedState } = pet ?? {}
      const request = kind === 'auto' && pet
        ? { state: observedState, ownerInteractions: trigger?.events ?? [], recentActivity: await observeRecentEvents(client, pet.session), guide: { stats: petCareGuide.stats, actions: petCareGuide.actions,
            food: { timing: petCareGuide.food.timing, result: petCareGuide.food.result, confirmation: petCareGuide.food.confirmation },
            headPet: petCareGuide.interactions.headPet, scenes: petCareGuide.scenes },
            catalog: { actions: playableActions, fruits, roomItems: petRoomItems, scenes: petScenes },
            previousPlan: previousPlan?.session === pet.session ? { accepted: previousPlan.accepted, stoppedBefore: previousPlan.stoppedBefore } : null }
        : '调用 pet_perform_sequence，只安排一步 blink，waitMs 为 0。'
      if (!stillEnabled()) return
      const decision = await decide(providerFor(saved), client, request, kind === 'auto' ? pet : undefined, saved.personality, requestAbort)
      if (!stillEnabled()) return
      if (kind !== 'auto' && (decision?.steps.length !== 1 || decision.steps[0].behavior !== 'blink' || decision.steps[0].waitMs !== 0)) {
        throw Error('模型没有返回预期的单步眨眼动作')
      }
      if (kind === 'connection') {
        setStatus({ phase: 'idle', message: '模型连接正常，已验证工具调用' })

      } else if (pet && decision?.name === 'pet_perform_sequence') {
        stepLabels = decision.steps.map(step => behaviorLabel(step.behavior))
        setStatus({ phase: 'thinking', message: '准备' + stepLabels[0],
          step: { label: stepLabels[0], index: 1, total: stepLabels.length, next: stepLabels[1] } })
        const outcome = z.object({ accepted: z.array(z.string()), stoppedBefore: z.string().optional() })
          .parse(await callPet(client, decision.name, { steps: decision.steps, session: pet.session }, requestAbort?.signal))
        if (!stillEnabled()) return
        previousPlan = { session: pet.session, accepted: outcome.accepted, stoppedBefore: outcome.stoppedBefore }
        const last = outcome.accepted.at(-1)
        setStatus({ phase: last ? 'action' : 'idle', lastDecision: last && !outcome.stoppedBefore ? stepLabels[outcome.accepted.length - 1] : undefined, message: outcome.stoppedBefore
          ? (last ? '已接收' + behaviorLabel(last) + '，' : '') + '已跳过' + behaviorLabel(outcome.stoppedBefore)
          : last ? '最近决定 · ' + behaviorLabel(last) + (outcome.accepted.length > 1 ? '（共 ' + outcome.accepted.length + ' 步）' : '') : '本轮没有执行动作' })
      } else {
        setStatus({ phase: 'idle', message: 'AI 让兔子保持当前状态' })
      }
    })
  } catch (error) {
    if (startingRevision === revision) setStatus({ phase: 'error', message: error instanceof z.ZodError ? '模型或设备返回的参数格式不正确'
      : error instanceof Error ? error.message : 'AI 控制失败' })
  } finally {
    running = false
    autoRunning = false
    requestAbort = undefined
    stepLabels = []
    if (trigger === reaction && !deferred) reaction = undefined
    schedule(startingRevision === revision ? intervalMs : 200)
  }
  return getPetAi()
}

export function testPetAi(kind: 'connection' | 'blink') {
  return run(kind)
}

function schedule(wait = 1500) {
  clearTimeout(timer)
  nextDecisionAt = undefined
  if (!running && observedSession !== null && store().get('settings')?.enabled) {
    if (reaction) wait = Math.max(0, reaction.due - Date.now())
    nextDecisionAt = Date.now() + wait
    timer = setTimeout(() => { void run('auto').catch(() => schedule(intervalMs)) }, wait)
  }
  publishActivity()
}

function interactionLabel(event: OwnerInteraction) {
  if (event.type === 'head_petted') return '摸头'
  if (event.type === 'fruit_queued') return '投喂' + fruitLabel[event.fruit]
  return '放下胡萝卜玩具'
}

function queueInteractions(session: string, incoming: OwnerInteraction[]) {
  if (!incoming.length || session !== observedSession || !store().get('settings')?.enabled) return
  const now = Date.now()
  const events = [...(reaction?.events ?? [])]
  // A stream of encoder detents is one touch. Keep recent distinct inputs bounded by the device event window.
  for (const event of incoming) {
    if (event.type === 'head_petted' && events.at(-1)?.type === event.type) events.pop()
    events.push(event)
  }
  const last = incoming[incoming.length - 1]
  reaction = { session, since: now, events: events.slice(-64), due: now + (last.type === 'head_petted' ? 900 : 180) }
  if (autoRunning) {
    revision++
    requestAbort?.abort()
  }
  if (!running || autoRunning) setStatus({ phase: 'idle', message: '收到互动 · ' + interactionLabel(last) })
  schedule()
}

// Replies to home-window writes are distinguishable from autonomous MCP writes even on older keyboards.
export function observePetOwnerCommand(session: string, command: number, value: number, payload: Uint8Array) {
  const item = command === 12 ? payload[19 + value] : undefined
  const fruit = fruits[(command === 2 ? value : item ?? 0) - 1]
  if (fruit) queueInteractions(session, [{ type: 'fruit_queued', fruit }])
  const toy = petToys.find(t => command === 7 && value === t.wireId || command === 12 && item === t.itemId)
  if (toy && payload[29 + payload[16]] === toy.wireId) {
    queueInteractions(session, [{ type: 'toy_placed', toy: toy.id }])
  }
}

function watchOwnerEvents(session: string | null | undefined) {
  stopEventWatch?.()
  stopEventWatch = undefined
  if (!session) return

  let cursor: string | undefined
  let active = true, primed = false, busy = false
  async function poll() {
    if (!active || busy) return
    busy = true
    try {
      for (let i = 0; i < 4; i++) {
        const page = await readPetEvents(cursor)
        if (!active || page.reset || !page.cursor.startsWith(session + ':')) return
        cursor = page.cursor
        if (primed) {
          const inputs: OwnerInteraction[] = []
          for (const e of page.events) {
            // The firmware records virtual pats as MCP. The built-in model cannot issue pats.
            if (e.type === 'head_petted' && (e.source === 'physical' || e.source === 'mcp')) inputs.push({ type: 'head_petted' })
            if (e.source !== 'physical') continue
            if (e.type === 'fruit_queued' && 'fruit' in e && e.fruit) inputs.push({ type: 'fruit_queued', fruit: e.fruit })
            if (e.type === 'toy_placed' && 'toy' in e && e.toy === 'carrot_toy') inputs.push({ type: 'toy_placed', toy: e.toy })
          }
          if (session) queueInteractions(session, inputs)
        }
        if (!page.hasMore) { primed = true; break }
      }
    } catch {
      // USB can be busy. Resume at the last acknowledged page on the next tick.
    } finally { busy = false }
  }
  const ticker = pollInterval(poll, 350)
  stopEventWatch = () => { active = false; stopPolling(ticker) }
  void poll()
}

// Home already reads the keyboard. Wake the scheduler once per confirmed entry or reconnect.
export function observePetAiSession(session: string | null) {
  if (session === observedSession) return
  const firstObservation = observedSession === undefined
  observedSession = session
  reaction = undefined
  const enabled = store().get('settings')?.enabled
  watchOwnerEvents(enabled ? session : null)
  if (!enabled) return
  if (running && !autoRunning) return
  if (firstObservation && session && autoRunning) return
  revision++
  requestAbort?.abort()
  activitySession = session ?? undefined
  setStatus({ phase: 'idle', message: session ? '准备读取键盘实况' : '等待键盘进入养宠模式' })
  schedule(200)
}

export function startPetAi(listener?: typeof activityListener) {
  activityListener = listener
  schedule()
}
export function stopPetAi() {
  activityListener = undefined
  observedSession = null
  reaction = undefined
  watchOwnerEvents(null)
  requestAbort?.abort()
  revision++
  clearTimeout(timer)
}
