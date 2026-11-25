<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import WindowTitle from '../components/tools/WindowTitle.vue'
import PerformanceDisplay from '../components/screenPage/PerformanceDisplay.vue'

const win = window as any
const selectedMenu = Number(useRoute().query.menu)
const menu = Number.isInteger(selectedMenu) && selectedMenu >= 0 && selectedMenu < 10 ? selectedMenu : 0
const values = ref<number[]>([])
const enabled = ref(false)
const hasImage = ref(false)
const loaded = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

async function sample() {
  values.value = await win.myApi.pcPerformance().catch(() => [])
}

onMounted(async () => {
  void sample()
  timer = setInterval(sample, 1500)
  try {
    const config = await win.myApi.getMenu('configData')
    const display = config ? JSON.parse(config)?.[menu]?.screenConfig?.[0] : undefined
    enabled.value = display?.content?.mode === 'performance'
    hasImage.value = Boolean(display?.baseData || display?.buffData?.length)
  } catch { /* Settings can still be applied to the selected layer. */ }
  loaded.value = true
})

onUnmounted(() => clearInterval(timer))

function switchDisplay() {
  win.myApi.setConfigStore({ screenPerformance: { menu, enabled: !enabled.value } })
  win.myApi.closeWindow()
}
</script>

<template>
  <div class="performance-window">
    <WindowTitle>
      <template #title>电脑性能监测</template>
    </WindowTitle>
    <main>
      <div class="monitor-context">
        <span>第 {{ menu + 1 }} 层 · 彩屏</span>
        <span v-if="loaded" class="current-source">{{ enabled ? '当前显示性能' : hasImage ? '当前显示图片' : '未指定彩屏内容' }}</span>
      </div>
      <PerformanceDisplay :values="values" />
      <footer>
        <p>彩屏实时更新需要保持 USB 连接。</p>
        <button type="button" :disabled="!loaded" @click="switchDisplay">
          {{ enabled ? (hasImage ? '切换为图片' : '停止在彩屏显示') : '在彩屏显示性能' }}
        </button>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.performance-window {
  box-sizing: border-box;
  height: 100vh;
  border: 5px solid #0d1927;
  border-radius: 18px;
  overflow: auto;
  background: #102032;
  color: #f0f6fb;
}
.performance-window :deep(.top-title) {
  color: inherit;
  border-bottom: 1px solid #293d52;
}
.performance-window :deep(.window-tools button) { color: #d8e5f2; }
.performance-window :deep(.window-tools button:not(.close):hover) { background: #294158; }
.performance-window :deep(.window-tools button:focus-visible) { outline-color: #79e5ce; }
main { padding: 13px 17px 16px; }
.monitor-context, footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.monitor-context { margin-bottom: 10px; font-size: 12px; font-weight: 650; }
.current-source { color: #b9cadd; font-weight: 500; }
footer { margin-top: 13px; }
footer p { margin: 0; color: #b9cadd; font-size: 11px; }
footer button {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid #79e5ce;
  border-radius: 7px;
  background: #79e5ce;
  color: #102032;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  cursor: pointer;
}
footer button:disabled { opacity: .5; cursor: default; }
footer button:focus-visible { outline: 2px solid #e0f8ff; outline-offset: 2px; }
</style>
