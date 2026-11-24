<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

defineProps<{ deviceReady: boolean }>()

interface AiState {
  apiUrl: string
  model: string
  enabled: boolean
  hasKey: boolean
  running: boolean
  status: { phase: string; message: string; sequence?: number }
}
const api = (window as any).myApi
const current = ref<AiState>()
const model = ref('')
const apiUrl = ref('')
const apiKey = ref('')
const enabled = ref(false)
const localOperation = ref(false)
const error = ref('')
const dirty = computed(() => apiUrl.value.trim() !== current.value?.apiUrl || model.value.trim() !== current.value?.model ||
  !!apiKey.value || enabled.value !== current.value?.enabled)
let timer: number | undefined

function load(state: AiState) {
  current.value = state
  apiUrl.value = state.apiUrl
  model.value = state.model
  enabled.value = state.enabled
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
  load(await api.savePetAi({ apiUrl: apiUrl.value, model: model.value, apiKey: apiKey.value, enabled: enabled.value }))
  apiKey.value = ''
})
const test = (kind: 'connection' | 'feed') => run(async () => { current.value = await api.testPetAi(kind) })
</script>

<template>
  <section class="pet-ai">
    <p>AI 根据兔子的状态选择动作。开启后每分钟最多决策一次。</p>
    <label>API 地址
      <input v-model.trim="apiUrl" type="url" placeholder="https://api.example.com/v1" maxlength="2048" autocomplete="off">
    </label>
    <label>模型
      <input v-model.trim="model" placeholder="支持工具调用的模型名" maxlength="200" autocomplete="off">
    </label>
    <label>API Key
      <input v-model="apiKey" type="password" maxlength="4096" autocomplete="new-password" :placeholder="current?.hasKey ? '已加密保存，留空沿用' : '填写模型服务的 Key'">
    </label>
    <label class="activation">
      <input v-model="enabled" type="checkbox"> 启用兔子自主动作
    </label>
    <div class="actions">
      <button type="button" :disabled="localOperation || !dirty || !apiUrl || !model" @click="save">保存配置</button>
      <button type="button" :disabled="localOperation || current?.running || dirty || !current?.hasKey" @click="test('connection')">测试连接</button>
      <button type="button" :disabled="localOperation || current?.running || dirty || !current?.hasKey || !deviceReady" @click="test('feed')">测试投喂苹果</button>
    </div>
    <p v-if="!deviceReady">测试投喂需要键盘已连接并进入养宠模式。</p>
    <p v-if="current?.status" class="status" role="status" :data-phase="current.status.phase">
      {{ current.status.message }}
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.pet-ai { display: grid; gap: 12px; }
.pet-ai p { margin: 0; font-size: 13px; }
.pet-ai label { display: grid; gap: 4px; font-size: 13px; }
.pet-ai input:not([type=checkbox]) { padding: 6px 8px; border: 1px solid #aab7bd; border-radius: 6px; font: inherit; width: 100%; box-sizing: border-box; }
.pet-ai .activation { display: flex; align-items: center; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.actions button { padding: 5px 8px; color: #203438; border: 1px solid #aab7bd; border-radius: 6px; background: #fff; }
.actions button:disabled { opacity: .5; }
.status { padding: 8px; border-radius: 6px; background: #e9f1ef; }
.status[data-phase=error], .status[data-phase=unconfirmed], [role=alert] { color: #8b312f; }
</style>
