import { safeStorage } from 'electron'
import Store from 'electron-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setInterval as pollInterval, clearInterval as stopPolling } from 'node:timers'
import { setTimeout as waitFor } from 'node:timers/promises'
import { z } from 'zod'
import { actionTiming, createPetMcp, readPetEvents, validActionTiming } from './petMcp'
import { defaultRabbitPersonality, personalityLimit, tokenPlanModels } from '../../src/utils/petPersonality'
import { petActionLabels, playableActions, petScenes, petToys, timedPetActions, petMaxDurationSeconds, petRecoveredEnergy,
  petHeadGestures, petFruitIds as fruits, petFruitLabels as fruitLabel } from '../../src/utils/petCatalog'

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
  interruptibleBehaviors: z.array(z.enum(playableActions)),
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
interface Status { step?: DecisionStep; lastDecision?: string; source?: string; phase: 'idle' | 'thinking' | 'action' | 'error'; message: string }
class ProviderError extends Error {}

interface Provider { endpoint: string; model: string; key: string }

let settingsStore: Store<{ settings: Settings }> | undefined
const store = () => settingsStore ??= new Store<{ settings: Settings }>({ name: 'pet-ai' })
const intervalMs = 60_000
const maxIdleActions = 8
const slotMs = 10_000
const reactionTimeoutMs = 4_000
const idleTimeoutMs = 8_000
const rateLimitMessage = '模型限流'
let providerRetryAt = 0
const defaultUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const defaultModel = tokenPlanModels[0]
let revision = 0
let running = false
let timer: ReturnType<typeof setTimeout> | undefined
let status: Status = { phase: 'idle', message: '等待下一次决策' }

let observedSession: string | null | undefined
type OwnerInteraction =
  | { type: 'head_petted'; gesture?: typeof petHeadGestures[number] }
  | { type: 'fruit_queued'; fruit: typeof fruits[number] }
  | { type: 'toy_placed'; toy: 'carrot_toy' }
interface Reaction { events: OwnerInteraction[]; session: string }
interface PlannedStep { action: RabbitAction; at: number; session: string; durationSeconds?: number; untilEnergy?: number }
let reaction: Reaction | undefined
let activeReaction: Reaction | undefined
let idleSteps: PlannedStep[] = []
let planEndAt = 0
let nextIdleAt: number | undefined
let stopEventWatch: (() => void) | undefined
let nextDecisionAt: number | undefined
let requestAbort: AbortController | undefined
let autoRunning = false
let deliveringAction = false
let activitySession: string | undefined
let activityVersion = 0
let activityListener: ((activity: ReturnType<typeof getPetAiActivity>) => void) | undefined

export function getPetAiActivity() {
  const next = idleSteps[0]
  return { version: activityVersion, enabled: !!store().get('settings')?.enabled, session: activitySession,
    phase: status.phase, message: status.message, step: status.step, lastDecision: status.lastDecision, source: status.source, nextDecisionAt,
    queue: next ? { next: behaviorLabel(next.action), remaining: idleSteps.length } : undefined }
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

function clearIdlePlan() {
  idleSteps = []
  planEndAt = 0
}

function shiftIdlePlan(delta: number) {
  for (const step of idleSteps) step.at += delta
  planEndAt += delta
}

function releaseSkippedSlot(start: number, durationSeconds = 0) {
  const unused = start + Math.max(slotMs, durationSeconds * 1000) - Date.now()
  if (planEndAt && unused > 0) shiftIdlePlan(-unused)
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
    hasKey: !!saved?.encryptedKey, running, status, activity: getPetAiActivity() }
}

export function savePetAi(input: unknown) {
  const { apiUrl, model, apiKey, enabled, personality } = settingsSchema.parse(input)
  const endpoint = endpointFor(apiUrl)
  const saved = store().get('settings')
  const encryptedKey = apiKey
    ? encryptKey(apiKey)
    : saved?.apiUrl === endpoint ? saved.encryptedKey : ''
  if (!encryptedKey && (enabled || saved?.encryptedKey)) throw Error('请填写此 API 地址的 API Key')
  if (saved?.apiUrl !== endpoint || saved.model !== model || apiKey) providerRetryAt = 0
  store().set('settings', { apiUrl: endpoint, model, encryptedKey, enabled,
    personality: (personality ?? saved?.personality) || defaultRabbitPersonality })
  revision++
  requestAbort?.abort()
  activitySession = undefined
  activeReaction = undefined
  reaction = undefined
  clearIdlePlan()
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
  '精神低时可睡，恢复到够用就醒。饱食或精神偏低时少做剧烈动作。' +
  'recentActions 是键盘最近接收的动作。结合性格和场景，从可用动作中换换花样，如散步、梳耳、眺望或看主人。' +
  '心情好、吃饱且精力充足时偶尔蹦跳或跳兔子舞，活跃动作之间留出安静时间。可以继续休息。' +
  '摸头事件中 tap 是轻点，cw 和 ccw 是顺、逆时针揉头。轻点可抬头看主人，揉头可梳耳、舔毛或眨眼。' +
  '主人投喂或给玩具时，优先留出时间吃东西或玩。rest 表示保留当前活动。只调用工具，不输出解释。'

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
            durationSeconds: { type: 'integer', minimum: 1, maximum: petMaxDurationSeconds, petRecoveredEnergy,
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
      signal.throwIfAborted()
      if (response.status === 429) {
        const header = response.headers.get('Retry-After')?.trim() ?? ''
        const now = Date.now()
        const until = /^\d+$/.test(header) ? now + Number(header) * 1000
          : /[a-z]{3}/i.test(header) ? Date.parse(header) : NaN
        providerRetryAt = Number.isSafeInteger(until) ? Math.max(now, until) : now + intervalMs
        throw new ProviderError(rateLimitMessage)
      }
      if (response.status === 401 && host === new URL(defaultUrl).hostname) {
        throw new ProviderError('Token Plan 返回 401，请使用对应套餐的专用 API Key')
      }
      throw new ProviderError('模型 API 返回 HTTP ' + response.status + '，请检查地址、模型和 Key')
    }
    body = await response.json()
  } catch (error) {
    signal.throwIfAborted()
    if (timeout.aborted) return { timedOut: true } as const
    if (error instanceof SyntaxError) throw new ProviderError('模型未返回有效 JSON')
    if (error instanceof TypeError) throw new ProviderError('无法连接模型 API，请检查网络或代理')
    throw error
  }
  const parsed = completionSchema.safeParse(body)
  if (!parsed.success) {
    if (typeof observation !== 'string') return { invalidReply: true } as const
    throw Error('模型未返回有效的工具调用格式')
  }
  const calls = parsed.data.choices[0].message.tool_calls ?? []
  if (!calls.length) return { invalidReply: true } as const
  if (typeof observation !== 'string') {
    const inputs = calls.slice(0, maxIdleActions).flatMap(call => {
      const sequence = sequenceCallSchema.safeParse(call)
      if (!sequence.success) return []
      const plan = stepsSchema.safeParse(readToolArguments(sequence.data.function.arguments))
      return plan.success ? plan.data.steps.slice(0, maxIdleActions) : []
    })
    if (planning) {
      const steps = inputs.slice(0, limit).map(input => automaticStep(input, choices, supportsTiming))
      return steps.some(Boolean) ? { steps: steps.map(step => step ?? { behavior: 'rest' as const }) }
        : { invalidReply: true } as const
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

const livelyActions: RabbitAction[] = ['run', 'jump', 'binky']
let history: { session: string; actions: RabbitAction[] } | undefined

const gestureResponses: Record<typeof petHeadGestures[number], RabbitAction[]> = {
  tap: ['gaze_owner', 'blink'], cw: ['groom_ear', 'blink'], ccw: ['groom_fur', 'blink']
}

function localDecision(pet: z.infer<typeof stateSchema>, reaction: OwnerInteraction | undefined, recent: RabbitAction[]) {
  const actions = reaction ? pet.reactionBehaviors : pet.automaticBehaviors
  if (pet.stats && pet.stats.energy <= 25 && actions.includes('sleep')) {
    return pet.generation >= 11 ? { behavior: 'sleep' as const, durationSeconds: petMaxDurationSeconds, untilEnergy: petRecoveredEnergy }
      : { behavior: 'sleep' as const }
  }
  let candidates: RabbitAction[]
  if (reaction) {
    candidates = reaction.type === 'toy_placed' ? ['stand_watch', 'walk', 'blink', 'gaze_owner']
      : reaction.type === 'head_petted' ? (reaction.gesture ? gestureResponses[reaction.gesture] : ['gaze_owner', 'blink', 'groom_ear', 'groom_fur'])
      : ['blink', 'gaze_owner', 'stand_watch']
  } else {
    candidates = ['daydream', 'groom_fur', 'walk', 'groom_ear', 'blink', 'gaze_owner']
    if (pet.scene === 'garden') candidates.push('stand_watch')
    if (pet.scene === 'nursery') candidates.push('inspect_table', 'stand_watch')
    if (pet.stats && pet.stats.energy >= 65 && pet.stats.satiety >= 55 && pet.stats.mood >= 65 &&
        !recent.slice(-2).some(action => livelyActions.includes(action))) candidates.push(...livelyActions)
  }
  const available = candidates.filter(action => actions.includes(action))
  if (!available.length) return undefined
  const oldest = Math.min(...available.map(action => recent.lastIndexOf(action)))
  const pool = available.filter(action => recent.lastIndexOf(action) === oldest)
  const behavior = reaction?.type === 'head_petted' && reaction.gesture ? pool[0] : pool[Math.floor(Math.random() * pool.length)]
  if (pet.generation >= 11 && behavior === 'daydream') return { behavior, durationSeconds: 25 }
  return { behavior }
}

async function run(kind: 'auto' | 'connection' | 'blink', scheduled?: PlannedStep) {
  if (running) throw Error('AI 正在处理上一轮')
  const saved = store().get('settings')
  if (!saved?.encryptedKey) throw Error('请先保存模型配置')
  if (kind === 'auto' && !saved.enabled) return getPetAi()
  const trigger = kind === 'auto' && !scheduled ? reaction : undefined
  const planning = kind === 'auto' && !trigger && !scheduled
  const roundStart = Date.now()
  if (planning) {
    clearIdlePlan()
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
      if (pet) activitySession = pet.session
      if (pet && !pet.active) {
        if (kind === 'blink') throw Error('请先让键盘进入养宠模式')
        setStatus({ phase: 'idle', message: '等待键盘进入养宠模式' })
        return
      }
      if (scheduled && scheduled.session !== pet?.session) return
      if (scheduled && Date.now() >= scheduled.at + slotMs) {
        releaseSkippedSlot(scheduled.at, scheduled.durationSeconds)
        return
      }
      if (trigger && trigger.session !== pet?.session) return

      const recent = history && history.session === pet?.session ? history.actions : []
      const last = recent.at(-1)
      let action: RabbitAction | undefined = scheduled?.action
      let durationSeconds = scheduled?.durationSeconds
      let untilEnergy = scheduled?.untilEnergy
      let fallbackReason: string | undefined
      let playBy = scheduled ? scheduled.at + slotMs : undefined
      if (!scheduled) {
        const automatic = (planning ? pet?.planningBehaviors : trigger ? pet?.reactionBehaviors : pet?.automaticBehaviors) ?? []
        const alternatives = automatic.filter(candidate => candidate !== last)
        const repeated = last !== undefined && recent.at(-2) === last
        const actions = kind === 'auto' ? ((trigger || repeated) && alternatives.length ? alternatives : automatic) : ['blink'] as const
        if (kind === 'auto' && pet && !actions.length) {
          const message = pet.action === 'eat' ? '正在进食，保持当前活动'
            : pet.action === 'sleep' ? '正在睡觉，保持当前活动'
            : pet.foodPending ? '食物已在场，等待兔子进食' : '兔子继续当前活动'
          setStatus({ phase: 'idle', source: '本地决定', message })
          return
        }
        if (kind === 'blink' && !automatic.includes('blink')) throw Error('请等兔子空闲时再测试眨眼')
        const coolingDown = Date.now() < providerRetryAt
        if (!coolingDown) setStatus({ phase: 'thinking', message: kind === 'connection' ? '正在测试模型工具调用'
          : trigger ? 'AI 正在回应' + interactionLabel(trigger.events.at(-1)!) : 'AI 正在编排接下来的动作' })
        const request = kind === 'auto' && pet
          ? { personality: saved.personality || defaultRabbitPersonality,
              observation: { stats: pet.stats, action: pet.action, scene: pet.scene, bedtime: pet.bedtime,
                ownerInteractions: trigger?.events ?? [], recentActions: recent.slice(-6), previousAction: last, generation: pet.generation,
                timedRemainingSeconds: pet.timedRemainingSeconds, foodPending: pet.foodPending } }
          : '调用 pet_perform_sequence，只安排一步 blink，waitMs 为 0。'
        const timeoutMs = kind === 'connection' ? 15_000 : trigger ? reactionTimeoutMs : idleTimeoutMs
        let result: Awaited<ReturnType<typeof decide>> | undefined
        try {
          if (coolingDown) throw new ProviderError(rateLimitMessage)
          result = await decide(providerFor(saved), request, actions, timeoutMs, controller.signal, planning, kind === 'auto' && (pet?.generation ?? 0) >= 11)
        } catch (error) {
          if (kind !== 'auto' || !(error instanceof ProviderError)) throw error
          fallbackReason = error.message
        }
        if (!stillEnabled()) return
        if (kind === 'auto') {
          if (result?.timedOut) fallbackReason = '模型超时'
          else if (result?.invalidReply) fallbackReason = '模型未给出可执行的动作'
        }
        if (fallbackReason && !coolingDown && pet) {
          const session = pet.session
          pet = await readState(client)
          if (!stillEnabled() || pet.session !== session || !pet.active) return
        }
        const first = fallbackReason && pet ? localDecision(pet, trigger?.events.at(-1), recent) : result?.steps?.[0]
        action = first?.behavior === 'rest' ? undefined : first?.behavior
        durationSeconds = first?.durationSeconds
        untilEnergy = first?.untilEnergy
        if (kind !== 'auto' && action !== 'blink') {
          throw Error(result?.timedOut ? '模型未在 ' + timeoutMs / 1000 + ' 秒内回复' : '模型没有返回预期的单步眨眼动作')
        }
        if (kind === 'connection') {
          setStatus({ phase: 'idle', message: '模型连接正常，已验证工具调用' })
          return
        }
        if (pet && planning && result?.steps) {
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
          planEndAt = at
        }
        if (!action) {
          setStatus({ phase: 'idle', message: fallbackReason ? fallbackReason + ' · 兔子继续当前活动'
            : planning && result?.steps ? '已编排本轮动作，兔子先自由活动' : 'AI 让兔子保持当前状态' })
          return
        }
      }

      if (!pet || !action) return
      const interrupt = !!trigger
      const eligible = (state: typeof pet) => interrupt ? state?.interruptibleBehaviors ?? [] : state?.automaticBehaviors ?? []
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
        const eating = (state: NonNullable<typeof pet>) => state.action === 'eat' ||
          (state.foodPending && !state.bedtime && (state.stats?.satiety ?? 100) < 90)
        while (!eligible(pet).length && !eating(pet) && pet.action !== action && Date.now() + 400 < playBy) {
          await waitFor(400, undefined, { signal: controller.signal })
          pet = await readState(client)
          if (!stillEnabled() || pet.session !== session || !pet.active) return
        }
        if (scheduled && !eligible(pet).length && eating(pet)) {
          // Keep this next step. Its eligibility is checked again using a fresh snapshot.
          idleSteps.unshift(scheduled)
          shiftIdlePlan(Date.now() + 2000 - scheduled.at)
          setStatus({ phase: 'idle', message: '等待进食结束，再继续已排动作' })
          return
        }
      }
      const label = behaviorLabel(action)
      if (!eligible(pet).includes(action) || (playBy !== undefined && Date.now() >= playBy)) {
        if (playBy !== undefined) releaseSkippedSlot(playBy - slotMs, durationSeconds)
        setStatus({ phase: 'idle', message: '兔子状态已变化，已跳过' + label })
        return
      }
      // Once delivery starts, a later interaction must not replay this reaction.
      deliveringAction = true
      const outcome = z.object({ accepted: z.array(z.string()), confirmation: z.literal('unknown').optional(),
        observedAction: z.string().optional(), reason: z.string().optional() })
        .parse(await callPet(client, actionTool, { steps: [{ behavior: action, durationSeconds, untilEnergy }],
          session: pet.session, interrupt }, controller.signal))
      if (!stillEnabled()) return
      if (outcome.confirmation === 'unknown') {
        if (outcome.observedAction === action) {
          if (kind === 'auto') history = { session: pet.session, actions: [...recent, action].slice(-playableActions.length) }
          setStatus({ phase: 'action', message: '已回读键盘，当前动作 · ' + label, lastDecision: label, source: '键盘回读' })
        } else {
          clearIdlePlan()
          setStatus({ phase: 'idle', message: '键盘未确认 · ' + label + '，已停止本轮后续动作' })
        }
        return
      }
      if (!outcome.accepted.length) {
        if (playBy !== undefined) releaseSkippedSlot(playBy - slotMs, durationSeconds)
        setStatus({ phase: 'idle', message: outcome.reason ? '已跳过' + label + ' · ' + outcome.reason : '兔子状态已变化，已跳过' + label })
        return
      }
      if (kind === 'auto') history = { session: pet.session, actions: [...recent, action].slice(-playableActions.length) }
      const local = trigger ? '本地回应' : '本地活动'
      const source = fallbackReason === rateLimitMessage ? '模型限流 · ' + local : fallbackReason ? local : undefined
      setStatus({ phase: 'action', lastDecision: label, source,
        message: (fallbackReason ? fallbackReason + ' · ' + local + ' · ' : '最近决定 · ') + label })
    })
  } catch (error) {
    if (startingRevision === revision) setStatus({ phase: 'error', message: error instanceof z.ZodError ? '模型或设备返回的参数格式不正确'
      : error instanceof Error ? error.message : 'AI 控制失败' })
  } finally {
    running = false
    autoRunning = false
    deliveringAction = false
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
    while (idleSteps.length && idleSteps[0].at + slotMs <= now) {
      const missed = idleSteps.shift()!
      releaseSkippedSlot(missed.at, missed.durationSeconds)
    }
    const step = idleSteps[0]
    nextDecisionAt = reaction ? now : Math.max(nextIdleAt, planEndAt)
    const playStep = !reaction && step && step.at < nextDecisionAt
    const due = playStep ? step.at : nextDecisionAt
    timer = setTimeout(() => {
      if (playStep) idleSteps.shift()
      void run('auto', playStep ? step : undefined).catch(() => schedule(intervalMs))
    }, Math.max(0, due - now))
  }
  publishActivity()
}

function interactionLabel(event: OwnerInteraction) {
  if (event.type === 'head_petted') return event.gesture === 'tap' ? '轻点兔头' : event.gesture === 'cw' ? '顺时针揉头' : event.gesture === 'ccw' ? '逆时针揉头' : '摸头'
  if (event.type === 'fruit_queued') return '投喂' + fruitLabel[event.fruit]
  return '放下胡萝卜玩具'
}

function queueInteractions(session: string, incoming: OwnerInteraction[]) {
  if (!incoming.length || session !== observedSession || !store().get('settings')?.enabled) return
  const now = Date.now()
  nextIdleAt = now + intervalMs
  clearIdlePlan()
  const pending = reaction ?? (deliveringAction ? undefined : activeReaction)
  const events = pending?.session === session ? [...pending.events] : []
  let previous = events.at(-1) ?? (activeReaction?.session === session ? activeReaction.events.at(-1) : undefined)
  const initialCount = events.length
  for (const event of incoming) {
    if (event.type === 'head_petted' && (event.gesture === 'cw' || event.gesture === 'ccw') &&
        previous?.type === 'head_petted' && previous.gesture === event.gesture) continue
    events.push(event)
    previous = event
  }
  if (events.length === initialCount) return
  const last = incoming[incoming.length - 1]
  reaction = { session, events: events.slice(-4) }
  if (autoRunning && !deliveringAction) {
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
    if (!session || !active || busy) return
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
            if (e.type === 'head_petted' && (e.source === 'physical' || e.source === 'mcp')) inputs.push({ type: 'head_petted', gesture: 'gesture' in e ? e.gesture : undefined })
            if (e.source !== 'physical') continue
            if (e.type === 'fruit_queued' && 'fruit' in e && e.fruit) inputs.push({ type: 'fruit_queued', fruit: e.fruit })
            if (e.type === 'toy_placed' && 'toy' in e && e.toy === 'carrot_toy') inputs.push({ type: 'toy_placed', toy: e.toy })
          }
          if (inputs.length) {
            queueInteractions(session, inputs)
          } else if (!reaction && !activeReaction && page.events.some(e =>
            e.type === 'decoration_finished' && 'decoration' in e && e.decoration === 'rabbit_hutch')) {
            // The firmware leaves the hutch on waking, including early energy-based wakeups.
            clearIdlePlan()
            if (autoRunning && !deliveringAction) {
              revision++
              requestAbort?.abort()
            }
            nextIdleAt = Date.now() + 200
            schedule()
          }
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
  if (history?.session !== session) history = undefined
  activeReaction = undefined
  reaction = undefined
  clearIdlePlan()
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
  history = undefined
  activeReaction = undefined
  reaction = undefined
  clearIdlePlan()
  nextIdleAt = undefined
  watchOwnerEvents(null)
  requestAbort?.abort()
  revision++
  clearTimeout(timer)
}
