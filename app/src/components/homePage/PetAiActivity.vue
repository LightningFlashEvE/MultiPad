<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{ session?: string }>()
interface Activity { version: number; enabled: boolean; session?: string; message: string }
const api = (window as any).myApi
const activity = ref<Activity>()
const unavailable = ref(false)
let unsubscribe: (() => void) | undefined

function update(value: Activity) {
  if (!activity.value || value.version >= activity.value.version) activity.value = value
}
onMounted(async () => {
  unsubscribe = api.onPetAiActivity(update)
  try { update(await api.getPetAiActivity()) } catch { unavailable.value = true }
})
onUnmounted(() => unsubscribe?.())

const message = computed(() => {
  const value = activity.value
  if (!value) return unavailable.value ? '暂时无法读取' : '正在读取'
  if (!value.enabled) return '未启用'
  if (!props.session) return '等待连接养宠键盘'
  if (value.session && value.session !== props.session) return '等待本次连接的决策'
  return value.message
})
</script>

<template>
  <div class="ai-activity" role="status" :title="'AI 决策 · ' + message">
    <strong>AI 决策</strong><span>{{ message }}</span>
  </div>
</template>

<style scoped>
.ai-activity { grid-area: 3 / 4 / 4 / 8; align-self: center; display: flex; align-items: baseline; gap: 7px; min-width: 0; color: #314750; font-size: 12px; }
strong { flex: none; color: #28564e; }
span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
