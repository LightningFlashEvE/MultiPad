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
  values.value = await win.myApi.pcPerformancePreview(menu + 1).catch(() => [])
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
  <div class="settings-window">
    <WindowTitle>
      <template #title>电脑性能监测</template>
    </WindowTitle>
    <main class="performance-body settings-scroll">
      <div class="monitor-context">
        <span>第 {{ menu + 1 }} 层 · 彩屏</span>
        <span v-if="loaded" class="current-source">{{ enabled ? '当前显示性能' : hasImage ? '当前显示图片' : '未指定彩屏内容' }}</span>
      </div>
      <PerformanceDisplay :values="values" />
      <footer>
        <p>彩屏实时更新需要保持 USB 连接。</p>
        <button type="button" class="settings-button is-primary" :disabled="!loaded" @click="switchDisplay">
          {{ enabled ? (hasImage ? '切换为图片' : '停止在彩屏显示') : '在彩屏显示性能' }}
        </button>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.performance-body { flex:1; padding:14px 16px 15px; background:var(--settings-canvas); }
.monitor-context, footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:7px 12px; }
.monitor-context { margin-bottom:9px; font-size:13px; font-weight:650; }
.current-source { color:var(--settings-muted); font-weight:500; }
.performance-display { width:100%; max-width:460px; margin-inline:auto; border-radius:8px; }
footer { margin-top:12px; }
footer p { color:var(--settings-muted); font-size:12px; }
</style>
