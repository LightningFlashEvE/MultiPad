import { safeStorage } from 'electron'
import Store from 'electron-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setInterval as pollInterval, clearInterval as stopPolling } from 'node:timers'
import { z } from 'zod'
import { createPetMcp, readPetEvents } from './petMcp'
import { defaultRabbitPersonality, personalityLimit } from '../../src/utils/petPersonality'
import { petActionLabels, playableActions, petScenes, petToys,
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
  session: z.string(), active: z.boolean(), action: z.string().nullable(),
  stats: z.object({ satiety: stat, energy: stat, mood: stat, affection: stat }).nullable(),
  scene: z.enum(petScenes).nullable(), bedtime: z.boolean().nullable(),
  headPet: z.object({ remainingMs: z.number().int().min(0).max(1200) }).nullable(),
  automaticBehaviors: z.array(z.enum(playableActions))
})
type RabbitAction = typeof playableActions[number]
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
const reactionTimeoutMs = 4_000
const idleTimeoutMs = 8_000
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
interface Reaction { events: OwnerInteraction[]; due: number; session: string }
let reaction: Reaction | undefined
let stopEventWatch: (() => void) | undefined
let nextDecisionAt: number | undefined
let requestAbort: AbortController | undefined
let autoRunning = false
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
      step: { label, index, total } })
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

const rabbitRole = '你扮演 MultiPad 键盘上温和的垂耳兔。结合性格、四项属性和主人刚做的事，' +
  '从工具列出的可用动作中选一个，用工具立即执行。优先回应主人或自然休息，避免重复上轮动作。' +
  'satiety 越高越饱，energy 越高越有精神，mood 越高越开心，affection 越高越亲近主人。' +
  '适合继续当前活动时，不调用工具，不输出文字。'

const actionTool = 'pet_perform_sequence'
const planSchema = z.object({ steps: z.tuple([z.object({
  behavior: z.enum(playableActions), waitMs: z.literal(0).default(0)
}).strict()]) }).strict()

async function decide(provider: Provider, observation: object | string, actions: readonly RabbitAction[],
  timeoutMs: number, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = AbortSignal.any([signal, timeout])
  const host = new URL(provider.endpoint).hostname
  const fastQwen = host === new URL(defaultUrl).hostname && provider.model === defaultModel
  const tools = [{ type: 'function', function: {
    name: actionTool,
    description: '立即执行一个兔子动作。每轮最多一步。',
    parameters: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
      steps: { type: 'array', minItems: 1, maxItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['behavior'], properties: {
          behavior: { type: 'string', enum: actions },
          waitMs: { type: 'integer', enum: [0] }
        }
      } }
    } }
  } }]

  let body: unknown
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { Authorization: 'Bearer ' + provider.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model, stream: false, tool_choice: 'auto',
        ...(fastQwen ? { enable_thinking: false, max_tokens: 128 } : {}),
        messages: [
          { role: 'system', content: typeof observation === 'string'
            ? '这是键盘宠物的工具调用诊断。只调用工具一次，省略文字。' : rabbitRole },
          { role: 'user', content: typeof observation === 'string' ? observation : JSON.stringify(observation) }
        ],
        tools
      })
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 && host === new URL(defaultUrl).hostname) {
        throw Error('Token Plan 返回 401，请使用对应套餐的专用 API Key')
      }
      throw Error('模型 API 返回 HTTP ' + response.status + '，请检查地址、模型和 Key')
    }
    body = await response.json()
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) return { timedOut: true } as const
    if (error instanceof SyntaxError) throw Error('模型未返回有效 JSON')
    if (error instanceof TypeError) throw Error('无法连接模型 API，请检查网络或代理')
    throw error
  }
  const parsed = completionSchema.safeParse(body)
  if (!parsed.success) throw Error('模型未返回有效的工具调用格式')
  const calls = parsed.data.choices[0].message.tool_calls ?? []
  if (!calls.length) return {}
  if (calls.length > 1) throw Error('模型一次请求了多个动作，本轮已跳过')
  const plan = planSchema.safeParse(JSON.parse(calls[0].function.arguments))
  if (!plan.success || !actions.includes(plan.data.steps[0].behavior)) throw Error('模型选择的动作不适合当前状态，本轮已跳过')
  return { action: plan.data.steps[0].behavior }
}

const readState = async (client: Client) => stateSchema.parse(await callPet(client, 'pet_get_state'))

let previousAction: { session: string; action: RabbitAction } | undefined

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
  const controller = new AbortController()
  requestAbort = controller
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
      if (trigger?.events.some(event => event.type === 'head_petted') && pet?.headPet?.remainingMs) {
        trigger.due = Date.now() + pet.headPet.remainingMs + 40
        deferred = true
        setStatus({ phase: 'idle', message: '等主人摸完头' })
        return
      }
      const automatic = pet?.automaticBehaviors ?? []
      const last = previousAction?.session === pet?.session ? previousAction?.action : undefined
      const alternatives = automatic.filter(action => action !== last)
      const actions: readonly RabbitAction[] = kind === 'auto' ? (alternatives.length ? alternatives : automatic) : ['blink']
      if (kind === 'auto' && !actions.length) {
        setStatus({ phase: 'idle', message: '兔子继续当前活动' })
        return
      }
      if (kind === 'blink' && !automatic.includes('blink')) throw Error('请等兔子空闲时再测试眨眼')
      setStatus({ phase: 'thinking', message: kind === 'connection' ? '正在测试模型工具调用' : trigger ? 'AI 正在回应' + interactionLabel(trigger.events.at(-1)!) : 'AI 正在选择兔子的动作' })
      const request = kind === 'auto' && pet
        ? { personality: saved.personality || defaultRabbitPersonality,
            observation: { stats: pet.stats, action: pet.action, scene: pet.scene, bedtime: pet.bedtime,
              ownerInteractions: trigger?.events.slice(-4) ?? [], previousAction: last } }
        : '调用 pet_perform_sequence，只安排一步 blink，waitMs 为 0。'
      const timeoutMs = kind === 'connection' ? 15_000 : trigger ? reactionTimeoutMs : idleTimeoutMs
      const decision = await decide(providerFor(saved), request, actions, timeoutMs, controller.signal)
      if (!stillEnabled()) return
      const fallback = decision.timedOut && !!trigger && automatic.includes('blink')
      const action = fallback ? 'blink' : decision.action
      if (kind !== 'auto' && action !== 'blink') {
        throw Error(decision.timedOut ? '模型未在 ' + timeoutMs / 1000 + ' 秒内回复' : '模型没有返回预期的单步眨眼动作')
      }
      if (kind === 'connection') {
        setStatus({ phase: 'idle', message: '模型连接正常，已验证工具调用' })

      } else if (pet && action) {
        const label = behaviorLabel(action)
        setStatus({ phase: 'thinking', message: '准备' + label, step: { label, index: 1, total: 1 } })
        const outcome = z.object({ accepted: z.array(z.string()), stoppedBefore: z.string().optional() })
          .parse(await callPet(client, actionTool, { steps: [{ behavior: action }], session: pet.session }, controller.signal))
        if (!stillEnabled()) return
        if (outcome.accepted.length) {
          if (kind === 'auto') previousAction = { session: pet.session, action }
          setStatus({ phase: 'action', lastDecision: label, message: (fallback ? '模型超时 · 本地回应 · ' : '最近决定 · ') + label })
        } else {
          setStatus({ phase: 'idle', message: '兔子状态已变化，已跳过' + label })
        }
      } else {
        setStatus({ phase: 'idle', message: decision.timedOut ? '模型超时，兔子继续当前活动' : 'AI 让兔子保持当前状态' })
      }
    })
  } catch (error) {
    if (startingRevision === revision) setStatus({ phase: 'error', message: error instanceof z.ZodError ? '模型或设备返回的参数格式不正确'
      : error instanceof Error ? error.message : 'AI 控制失败' })
  } finally {
    running = false
    autoRunning = false
    requestAbort = undefined
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
  reaction = { session, events: events.slice(-4), due: now + (last.type === 'head_petted' ? 350 : 100) }
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
