<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { defaultRabbitPersonality, personalityLimit, tokenPlanModels } from '../../utils/petPersonality'

defineProps<{ deviceReady: boolean }>()

interface AiState {
  apiUrl: string
  model: string
  personality: string
  enabled: boolean
  hasKey: boolean
  running: boolean
  status: { phase: string; message: string }
  activity: { queue?: { next: string; remaining: number } }
}
const api = (window as any).myApi
const current = ref<AiState>()
const model = ref('')
const modelChoice = computed(() => tokenPlanModels.find(option => option === model.value) ?? 'custom')
function chooseModel(event: Event) {
  const selection = (event.target as HTMLSelectElement).value
  model.value = selection === 'custom' ? '' : selection
}
const apiUrl = ref('')
const apiKey = ref('')
const personality = ref(defaultRabbitPersonality)
const enabled = ref(false)
const localOperation = ref(false)
const error = ref('')
const dirty = computed(() => apiUrl.value.trim() !== current.value?.apiUrl || model.value.trim() !== current.value?.model ||
  !!apiKey.value || enabled.value !== current.value?.enabled ||
  (personality.value.trim() || defaultRabbitPersonality) !== current.value?.personality)
let timer: number | undefined

function load(state: AiState) {
  current.value = state
  apiUrl.value = state.apiUrl
  model.value = state.model
  enabled.value = state.enabled
  personality.value = state.personality || defaultRabbitPersonality
}

async function run(operation: () => Promise<void>) {
  error.value = ''
  localOperation.value = true
  try {
    await operation()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'AI 设置操作失败'
  } finally {
    localOperation.value = false
  }
}

onMounted(() => {
  void run(async () => load(await api.getPetAi()))
  timer = window.setInterval(async () => {
    try {
      const state = await api.getPetAi()
      if (current.value) current.value = state
    } catch {
      // The next refresh can recover from a temporarily unavailable main process.
    }
  }, 550)
})
onUnmounted(() => window.clearInterval(timer))

const save = () => run(async () => {
  load(await api.savePetAi({ apiUrl: apiUrl.value, model: model.value, apiKey: apiKey.value, enabled: enabled.value,
    personality: personality.value }))
  apiKey.value = ''
})
const test = (kind: 'connection' | 'blink') => run(async () => { current.value = await api.testPetAi(kind) })
</script>

<template>
  <section class="pet-ai">
    <p class="wide intro">摸头、投喂或放玩具会优先触发 AI 回应。空闲时大约每分钟编排一轮，长动作可以继续执行。模型超时或返回无效动作时，兔子会按当前状态做出本地回应或继续活动。</p>
    <label>API 地址
      <input v-model.trim="apiUrl" class="settings-field" type="url" placeholder="https://api.example.com/v1" maxlength="2048" autocomplete="off">
    </label>
    <label>模型
      <select class="settings-field" :value="modelChoice" @change="chooseModel">
        <optgroup label="百炼 Token Plan">
          <option v-for="option in tokenPlanModels" :key="option" :value="option">{{ option }}</option>
        </optgroup>
        <option value="custom">自定义模型</option>
      </select>
    </label>
    <label v-if="modelChoice === 'custom'">自定义模型名
      <input v-model.trim="model" class="settings-field" placeholder="支持工具调用的模型名" maxlength="200" autocomplete="off">
    </label>
    <label>API Key
      <input v-model="apiKey" class="settings-field" type="password" maxlength="4096" autocomplete="new-password" :placeholder="current?.hasKey ? '已加密保存，留空沿用' : '填写模型服务的 Key'">
    </label>
    <label class="activation" :class="{ wide: modelChoice === 'custom' }">
      <input v-model="enabled" type="checkbox"> 启用兔子自主动作
    </label>
    <label class="wide">兔子的角色设定
      <textarea v-model="personality" class="settings-field" rows="2" :maxlength="personalityLimit" :placeholder="defaultRabbitPersonality"></textarea>
    </label>
    <button v-if="personality !== defaultRabbitPersonality" class="reset-personality wide" type="button"
      @click="personality = defaultRabbitPersonality">恢复默认性格</button>
    <div class="actions wide">
      <button type="button" class="settings-button is-primary" :disabled="localOperation || !dirty || !apiUrl || !model" @click="save">保存配置</button>
      <button type="button" class="settings-button" :disabled="localOperation || current?.running || dirty || !current?.hasKey" @click="test('connection')">测试连接</button>
      <button type="button" class="settings-button" :disabled="localOperation || current?.running || dirty || !current?.hasKey || !deviceReady" @click="test('blink')">测试兔子眨眼</button>
    </div>
    <p v-if="!deviceReady" class="wide">测试眨眼需要键盘已连接并进入养宠模式。</p>
    <p v-if="current?.status" class="status wide" role="status" :data-phase="current.status.phase">
      {{ current.status.message }}
      <span v-if="current.activity.queue" class="queue">接下来 · {{ current.activity.queue.next }}（待执行 {{ current.activity.queue.remaining }} 步）</span>
    </p>
    <p v-if="error" class="wide" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.pet-ai { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 12px; padding:14px; border-radius:10px; background:var(--settings-surface); }
.wide { grid-column:1/-1; }
.pet-ai p { margin:0; color:var(--settings-muted); font-size:12px; }
.intro { padding-bottom:10px; border-bottom:1px solid var(--settings-line); }
.pet-ai label { display:grid; gap:4px; align-content:start; font-size:13px; font-weight:600; }
.pet-ai textarea { resize: vertical; }
.reset-personality { justify-self:start; border:0; padding:0; background:transparent; color:#2c665b; cursor:pointer; }
.pet-ai .activation { display:flex; min-height:34px; align-items:center; align-self:end; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.activation input { accent-color:var(--settings-accent); }
.status { padding:8px; border-radius:6px; background:var(--settings-group); }
.queue { display:block; margin-top:4px; }
.status[data-phase=error], .status[data-phase=unconfirmed], [role=alert] { color: #8b312f; }
@media(max-width:480px) { .pet-ai { grid-template-columns:1fr; padding:11px; } }
</style>
