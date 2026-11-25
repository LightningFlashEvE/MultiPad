import { safeStorage } from 'electron'
import Store from 'electron-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setInterval as pollInterval, clearInterval as stopPolling } from 'node:timers'
import { setTimeout as waitFor } from 'node:timers/promises'
import { z } from 'zod'
import { actionTiming, createPetMcp, readPetEvents, validActionTiming } from './petMcp'
import { defaultRabbitPersonality, personalityLimit, tokenPlanModels } from '../../src/utils/petPersonality'
import { petActionLabels, playableActions, petScenes, petToys, timedPetActions, petMaxDurationSeconds,
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
  session: z.string(), active: z.boolean(), action: z.string().nullable(), generation: z.number(),
  timedRemainingSeconds: z.number().nullable(), foodPending: z.boolean().optional(),
  stats: z.object({ satiety: stat, energy: stat, mood: stat, affection: stat }).nullable(),
  scene: z.enum(petScenes).nullable(), bedtime: z.boolean().nullable(),
  headPet: z.object({ remainingMs: z.number().int().min(0).max(1200) }).nullable(),
  automaticBehaviors: z.array(z.enum(playableActions)),
  reactionBehaviors: z.array(z.enum(playableActions)),
  planningBehaviors: z.array(z.enum(playableActions))
})
type RabbitAction = typeof playableActions[number]
const sequenceCallSchema = z.object({
  type: z.literal('function'),
  function: z.object({ name: z.literal('pet_perform_sequence'), arguments: z.string().max(2048) })
})
const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ tool_calls: z.array(z.unknown()).optional().nullable() })
  })).min(1)
})

interface Settings { apiUrl: string; model: string; encryptedKey: string; enabled: boolean; personality?: string }
interface DecisionStep { label: string; index: number; total: number; next?: string }
interface Status { step?: DecisionStep; lastDecision?: string; phase: 'idle' | 'thinking' | 'action' | 'error'; message: string }
interface Provider { endpoint: string; model: string; key: string }

let settingsStore: Store<{ settings: Settings }> | undefined
const store = () => settingsStore ??= new Store<{ settings: Settings }>({ name: 'pet-ai' })
const intervalMs = 60_000
const maxIdleActions = 8
const slotMs = 10_000
const reactionTimeoutMs = 4_000
const idleTimeoutMs = 8_000
const defaultUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const defaultModel = tokenPlanModels[0]
let revision = 0
let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let status: Status = { phase: 'idle', message: '等待下一次决策' }

let observedSession: string | null | undefined
type OwnerInteraction =
  | { type: 'head_petted' }
  | { type: 'fruit_queued'; fruit: typeof fruits[number] }
  | { type: 'toy_placed'; toy: 'carrot_toy' }
interface Reaction { events: OwnerInteraction[]; session: string }
interface PlannedStep { action: RabbitAction; at: number; session: string; durationSeconds?: number; untilEnergy?: number }
let reaction: Reaction | undefined
let activeReaction: Reaction | undefined
let idleSteps: PlannedStep[] = []
let nextIdleAt: number | undefined
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
  idleSteps = []
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

const rabbitRole = '你扮演 MultiPad 键盘上的垂耳兔。选择符合性格、属性和主人互动的动作。' +
  'satiety 越高越饱，energy 越高越有精神，mood 越高越开心，affection 越高越亲近主人。' +
  '精神低时可短睡，恢复到够用就醒，无需每次回满。避免连续重复动作。rest 表示保留当前活动。不要输出解释。'

const actionTool = 'pet_perform_sequence'
const automaticStepSchema = z.object({ behavior: z.enum([...playableActions, 'rest']),
  durationSeconds: z.unknown().optional(), untilEnergy: z.unknown().optional() })
const decisionStepSchema = z.object({
  behavior: z.enum([...playableActions, 'rest']), waitMs: z.literal(0).default(0), ...actionTiming
}).strict()
const stepsSchema = z.object({ steps: z.array(z.unknown()).min(1) })

function readToolArguments(input: string): unknown {
  try { return JSON.parse(input) } catch { return undefined }
}

function optionalInteger(input: unknown) {
  return typeof input === 'string' && /^\d+$/.test(input.trim()) ? Number(input) : input
}

function automaticStep(input: unknown, choices: readonly string[], supportsTiming: boolean) {
  const parsed = automaticStepSchema.safeParse(input)
  if (!parsed.success || !choices.includes(parsed.data.behavior)) return undefined
  const { behavior } = parsed.data
  if (!supportsTiming || !timedPetActions.some(action => action === behavior)) return { behavior }
  const durationSeconds = actionTiming.durationSeconds.safeParse(optionalInteger(parsed.data.durationSeconds))
  if (!durationSeconds.success || durationSeconds.data === undefined) return { behavior }
  const untilEnergy = actionTiming.untilEnergy.safeParse(optionalInteger(parsed.data.untilEnergy))
  return { behavior, durationSeconds: durationSeconds.data,
    untilEnergy: behavior === 'sleep' && untilEnergy.success ? untilEnergy.data : undefined }
}

async function decide(provider: Provider, observation: object | string, actions: readonly RabbitAction[],
  timeoutMs: number, signal: AbortSignal, planning = false, supportsTiming = false) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = AbortSignal.any([signal, timeout])
  const host = new URL(provider.endpoint).hostname
  const fastQwen = host === new URL(defaultUrl).hostname && tokenPlanModels.some(model => model === provider.model)
  const limit = planning ? maxIdleActions : 1
  const choices = typeof observation === 'string' ? actions : [...actions, 'rest']
  const tools = [{ type: 'function', function: {
    name: actionTool,
    description: planning
      ? '选 1–8 个动作，按顺序执行。动作间留出自然停顿，可用 rest。无需计算总时长或填写等待时间。'
      : '立即回应主人，选择一个动作，无需填写等待时间。rest 表示保持当前活动。',
    parameters: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
      steps: { type: 'array', minItems: 1, maxItems: limit, items: {
        type: 'object', additionalProperties: false, required: ['behavior'], properties: {
          behavior: { type: 'string', enum: choices },
          ...(typeof observation === 'string' ? { waitMs: { type: 'integer', enum: [0] } } : {}),
          ...(supportsTiming ? {
            durationSeconds: { type: 'integer', minimum: 1, maximum: petMaxDurationSeconds,
              description: '执行时长，自动作开始计时，适用于 ' + timedPetActions.join(', ') },
            untilEnergy: { type: 'integer', minimum: 40, maximum: 90,
              description: '仅用于带时长的 sleep。达到此精神值可提前醒来，一般建议 60–75。' }
          } : {})
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
        ...(fastQwen ? { enable_thinking: false, max_tokens: planning ? 256 : 128 } : {}),
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
  if (!parsed.success) {
    if (typeof observation !== 'string') return { invalidReply: true } as const
    throw Error('模型未返回有效的工具调用格式')
  }
  const calls = parsed.data.choices[0].message.tool_calls ?? []
  if (!calls.length) return {}
  if (typeof observation !== 'string') {
    const inputs = calls.slice(0, maxIdleActions).flatMap(call => {
      const sequence = sequenceCallSchema.safeParse(call)
      if (!sequence.success) return []
      const plan = stepsSchema.safeParse(readToolArguments(sequence.data.function.arguments))
      return plan.success ? plan.data.steps.slice(0, maxIdleActions) : []
    })
    if (planning && inputs.length) {
      return { steps: inputs.slice(0, limit).map(input =>
        automaticStep(input, choices, supportsTiming) ?? { behavior: 'rest' as const }) }
    }
    for (const input of inputs) {
      const step = automaticStep(input, choices, supportsTiming)
      if (step) return { steps: [step] }
    }
    return { invalidReply: true } as const
  }
  const sequence = sequenceCallSchema.safeParse(calls[0])
  if (calls.length !== 1 || !sequence.success) throw Error('连接测试需要模型调用一次动作工具')
  const args = readToolArguments(sequence.data.function.arguments)
  const plan = z.object({ steps: z.tuple([decisionStepSchema]) }).strict().safeParse(args)
  if (!plan.success || plan.data.steps.some(step => !choices.includes(step.behavior) ||
      !validActionTiming(step.behavior, step.durationSeconds, step.untilEnergy) || (!supportsTiming && step.durationSeconds !== undefined))) {
    throw Error('连接测试需要单步眨眼，且等待时间为 0')
  }
  return { steps: plan.data.steps }
}

const readState = async (client: Client) => stateSchema.parse(await callPet(client, 'pet_get_state'))

let previousAction: { session: string; action: RabbitAction } | undefined

async function run(kind: 'auto' | 'connection' | 'blink', scheduled?: PlannedStep) {
  if (running) throw Error('AI 正在处理上一轮')
  const saved = store().get('settings')
  if (!saved?.encryptedKey) throw Error('请先保存模型配置')
  if (kind === 'auto' && !saved.enabled) return getPetAi()
  const trigger = kind === 'auto' && !scheduled ? reaction : undefined
  const planning = kind === 'auto' && !trigger && !scheduled
  const roundStart = Date.now()
  if (planning) {
    idleSteps = []
    nextIdleAt = roundStart + intervalMs
  }
  if (trigger) reaction = undefined
  activeReaction = trigger
  const startingRevision = revision
  running = true
  autoRunning = kind === 'auto'
  clearTimeout(timer)
  const controller = new AbortController()
  requestAbort = controller
  try {
    await withPetMcp(async client => {
      const stillEnabled = () => startingRevision === revision
      let pet = kind === 'connection' ? undefined : await readState(client)
      if (!stillEnabled()) return
      activitySession = pet?.session
      if (pet && !pet.active) {
        if (kind === 'blink') throw Error('请先让键盘进入养宠模式')
        setStatus({ phase: 'idle', message: '等待键盘进入养宠模式' })
        return
      }
      if (scheduled && (scheduled.session !== pet?.session || Date.now() >= scheduled.at + slotMs)) return
      if (trigger && trigger.session !== pet?.session) return

      const last = previousAction?.session === pet?.session ? previousAction?.action : undefined
      let action: RabbitAction | undefined = scheduled?.action
      let durationSeconds = scheduled?.durationSeconds
      let untilEnergy = scheduled?.untilEnergy
      let fallbackReason: string | undefined
      let playBy = scheduled ? scheduled.at + slotMs : undefined
      if (!scheduled) {
        const automatic = (planning ? pet?.planningBehaviors : trigger ? pet?.reactionBehaviors : pet?.automaticBehaviors) ?? []
        const alternatives = automatic.filter(candidate => candidate !== last)
        const actions = kind === 'auto' ? (trigger && alternatives.length ? alternatives : automatic) : ['blink'] as const
        if (kind === 'blink' && !automatic.includes('blink')) throw Error('请等兔子空闲时再测试眨眼')
        setStatus({ phase: 'thinking', message: kind === 'connection' ? '正在测试模型工具调用'
          : trigger ? 'AI 正在回应' + interactionLabel(trigger.events.at(-1)!) : 'AI 正在编排接下来的动作' })
        const request = kind === 'auto' && pet
          ? { personality: saved.personality || defaultRabbitPersonality,
              observation: { stats: pet.stats, action: pet.action, scene: pet.scene, bedtime: pet.bedtime,
                ownerInteractions: trigger?.events ?? [], previousAction: last, generation: pet.generation,
                timedRemainingSeconds: pet.timedRemainingSeconds, foodPending: pet.foodPending } }
          : '调用 pet_perform_sequence，只安排一步 blink，waitMs 为 0。'
        const timeoutMs = kind === 'connection' ? 15_000 : trigger ? reactionTimeoutMs : idleTimeoutMs
        const result = await decide(providerFor(saved), request, actions, timeoutMs, controller.signal, planning, kind === 'auto' && (pet?.generation ?? 0) >= 11)
        if (!stillEnabled()) return
        if (trigger && automatic.includes('blink')) {
          if (result.timedOut) fallbackReason = '模型超时'
          else if (result.invalidReply) fallbackReason = '模型未给出可执行的动作'
        }
        const first = result.steps?.[0]
        action = fallbackReason ? 'blink' : first?.behavior === 'rest' ? undefined : first?.behavior
        durationSeconds = first?.durationSeconds
        untilEnergy = first?.untilEnergy
        if (kind !== 'auto' && action !== 'blink') {
          throw Error(result.timedOut ? '模型未在 ' + timeoutMs / 1000 + ' 秒内回复' : '模型没有返回预期的单步眨眼动作')
        }
        if (kind === 'connection') {
          setStatus({ phase: 'idle', message: '模型连接正常，已验证工具调用' })
          return
        }
        if (pet && planning && result.steps) {
          const session = pet.session
          const playbackStart = Date.now()
          playBy = playbackStart + slotMs
          let at = playbackStart
          idleSteps = result.steps.flatMap((step, index) => {
            const start = at
            at += Math.max(slotMs, (step.durationSeconds ?? 0) * 1000)
            return index > 0 && step.behavior !== 'rest'
              ? [{ action: step.behavior, at: start, session, durationSeconds: step.durationSeconds, untilEnergy: step.untilEnergy }] : []
          })
          nextIdleAt = Math.max(roundStart + intervalMs, at)
        }
        if (!action) {
          setStatus({ phase: 'idle', message: result.timedOut ? '模型超时，兔子继续当前活动'
            : result.invalidReply ? '模型未给出可执行的动作，兔子继续当前活动'
            : planning && result.steps ? '已编排下一轮，兔子先自由活动' : 'AI 让兔子保持当前状态' })
          return
        }
      }

      if (!pet || !action) return
      if (trigger?.events.some(event => event.type === 'head_petted')) {
        // Decide as soon as the gesture is seen. Wait only to deliver the selected
        // response so a held encoder cannot interrupt or be interrupted by the AI.
        const deadline = Date.now() + intervalMs
        while (pet.headPet?.remainingMs && Date.now() < deadline) {
          await waitFor(Math.min(pet.headPet.remainingMs + 20, 200), undefined, { signal: controller.signal })
          pet = await readState(client)
          if (!stillEnabled() || pet.session !== trigger.session) return
        }
      }
      if (playBy) {
        const session = pet.session
        while (!pet.automaticBehaviors.length && pet.action !== action && Date.now() + 400 < playBy) {
          await waitFor(400, undefined, { signal: controller.signal })
          pet = await readState(client)
          if (!stillEnabled() || pet.session !== session || !pet.active) return
        }
      }
      const label = behaviorLabel(action)
      if (!pet.automaticBehaviors.includes(action) || (playBy !== undefined && Date.now() >= playBy)) {
        setStatus({ phase: 'idle', message: '兔子状态已变化，已跳过' + label })
        return
      }
      const outcome = z.object({ accepted: z.array(z.string()) })
        .parse(await callPet(client, actionTool, { steps: [{ behavior: action, durationSeconds, untilEnergy }], session: pet.session }, controller.signal))
      if (!stillEnabled()) return
      if (!outcome.accepted.length) {
        setStatus({ phase: 'idle', message: '兔子状态已变化，已跳过' + label })
        return
      }
      if (kind === 'auto') previousAction = { session: pet.session, action }
      setStatus({ phase: 'action', lastDecision: label, message: (fallbackReason ? fallbackReason + ' · 本地回应 · ' : '最近决定 · ') + label })
    })
  } catch (error) {
    if (startingRevision === revision) setStatus({ phase: 'error', message: error instanceof z.ZodError ? '模型或设备返回的参数格式不正确'
      : error instanceof Error ? error.message : 'AI 控制失败' })
  } finally {
    running = false
    autoRunning = false
    activeReaction = undefined
    requestAbort = undefined
    schedule()
  }
  return getPetAi()
}

export function testPetAi(kind: 'connection' | 'blink') {
  return run(kind)
}

function schedule(initialDelay?: number) {
  clearTimeout(timer)
  nextDecisionAt = undefined
  if (initialDelay !== undefined) nextIdleAt = Date.now() + initialDelay
  if (!running && observedSession !== null && store().get('settings')?.enabled) {
    const now = Date.now()
    nextIdleAt ??= now + 1500
    idleSteps = idleSteps.filter(step => step.at + slotMs > now)
    const step = idleSteps[0]
    const playStep = !reaction && step && step.at < nextIdleAt
    nextDecisionAt = reaction ? now : nextIdleAt
    const due = playStep ? step.at : nextDecisionAt
    timer = setTimeout(() => {
      if (playStep) idleSteps.shift()
      void run('auto', playStep ? step : undefined).catch(() => schedule(intervalMs))
    }, Math.max(0, due - now))
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
  nextIdleAt = now + intervalMs
  idleSteps = []
  const heldTouch = incoming.every(event => event.type === 'head_petted') &&
    activeReaction?.session === session && activeReaction.events.at(-1)?.type === 'head_petted'
  if (heldTouch) return
  const events = [...(reaction?.events ?? [])]
  // A stream of encoder detents is one touch. Keep recent distinct inputs bounded by the device event window.
  for (const event of incoming) {
    if (event.type === 'head_petted' && events.at(-1)?.type === event.type) events.pop()
    events.push(event)
  }
  const last = incoming[incoming.length - 1]
  reaction = { session, events: events.slice(-4) }
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
  idleSteps = []
  nextIdleAt = session ? Date.now() + 200 : undefined
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
  idleSteps = []
  nextIdleAt = undefined
  watchOwnerEvents(null)
  requestAbort?.abort()
  revision++
  clearTimeout(timer)
}
