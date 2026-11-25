<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import WindowTitle from '../components/tools/WindowTitle.vue'
import PopBox from '../components/tools/PopBox.vue'
import ScreenEditor from '../components/screenPage/screenEditor.vue'
import { encodeOled, renderScreenContent } from '../components/screenPage/screenContent'
import type { ScreenContent, ScreenFrame } from '../components/screenPage/screenContent'

const win = window as any
const route = useRoute()
const screen = [0, 1, 2].includes(Number(route.query.screen)) ? Number(route.query.screen) : 0
const menu = Math.min(9, Math.max(0, Number(route.query.menu) || 0))
const initial = ref<ScreenFrame>()
const loaded = ref(false)
const mode = ref<ScreenContent['mode'] | 'image'>(screen === 0 ? 'image' : 'time')
const text = ref('')
const url = ref('')
const field = ref('')
const label = ref('')
const interval = ref(60)
const preview = ref('')
const imageMounted = ref(false)
const busy = ref(false)
const error = ref('')
const modes = [
  { value: 'image', label: '图片' },
  { value: 'time', label: '时间' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '时间和日期' },
  { value: 'text', label: '自定义文字' },
  { value: 'api', label: 'API 数据' }
] as const

onMounted(async () => {
  try {
    const saved = await win.myApi.getMenu('configData')
    initial.value = saved ? JSON.parse(saved)?.[menu]?.screenConfig?.[screen] : undefined
    const content = initial.value?.content
    if (screen !== 0 && content && modes.some(option => option.value === content.mode)) {
      mode.value = content.mode
      if (content.mode === 'api') {
        url.value = content.url
        field.value = content.field
        label.value = content.label
        interval.value = content.interval
      } else if (content.mode === 'text') {
        text.value = content.text
      }
    } else if (initial.value?.baseData) {
      mode.value = 'image'
    }
  } catch {
    error.value = '读取屏幕配置失败'
  } finally {
    loaded.value = true
  }
})

const content = computed<ScreenContent | undefined>(() => {
  switch (mode.value) {
    case 'image':
    case 'pet': return
    case 'text': return { mode: 'text', text: text.value.trim() }
    case 'api': return { mode: 'api', url: url.value.trim(), field: field.value.trim(), label: label.value.trim(), interval: interval.value }
    default: return { mode: mode.value }
  }
})

watch([loaded, content], async ([ready, current], _previous, onCleanup) => {
  let cancelled = false
  onCleanup(() => { cancelled = true })
  preview.value = ''
  if (!ready || !current || current.mode === 'api' || (current.mode === 'text' && !current.text)) return
  const png = await renderScreenContent(current)
  if (!cancelled) preview.value = png
})

watch([loaded, mode], ([ready, value]) => {
  if (ready && value === 'image') imageMounted.value = true
})

const close = () => win.myApi.closeWindow()
const save = (frame: ScreenFrame) => {
  win.myApi.setConfigStore({ screenFrame: { screen, menu, frame } })
  close()
}

const generate = async (commit: boolean) => {
  const current = content.value
  if (busy.value || !current) return
  error.value = ''
  if (current.mode === 'api' && (!Number.isInteger(current.interval) || current.interval < 15 || current.interval > 3600)) {
    error.value = '刷新间隔须为 15 至 3600 秒'
    return
  }
  busy.value = true
  try {
    const png = await renderScreenContent(current)
    if (content.value !== current) return
    preview.value = png
    if (commit) {
      const frame = await encodeOled(png)
      if (current.mode !== 'text') frame.buffData = []
      save({ ...frame, content: current })
    }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '生成屏幕内容失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <PopBox />
  <div class="settings-window screen-window">
    <WindowTitle>
      <template #title>{{ screen ? `小屏 ${screen} · 菜单 ${menu + 1}` : '彩屏图片编辑' }}</template>
    </WindowTitle>
    <main class="screen-body settings-scroll">
    <p v-if="screen === 0 && initial?.content?.mode === 'performance'" class="image-mode-hint">
      此层彩屏正在显示性能。保存图片后，可在性能监测页面切换为图片。
    </p>
    <nav v-if="screen !== 0" class="screen-modes" aria-label="显示内容">
      <button v-for="option in modes" :key="option.value" type="button" class="settings-button" :aria-pressed="mode === option.value"
        :disabled="!loaded || busy" @click="mode = option.value; error = ''">{{ option.label }}</button>
    </nav>
    <div v-if="imageMounted" v-show="mode === 'image'" class="image-editor">
      <ScreenEditor :screen="screen" :initial-image="screen && initial?.content ? undefined : initial?.baseData" @save="save" />
    </div>
    <form v-if="loaded && mode !== 'image'" class="screen-settings" @submit.prevent="generate(true)">
      <div class="screen-preview">
        <img v-if="preview" :src="preview" alt="小屏预览" />
        <span v-else>{{ mode === 'api' ? '测试后预览' : '小屏预览' }}</span>
      </div>
      <div class="screen-fields">
        <template v-if="mode === 'api'">
          <label>API 地址<input v-model="url" class="settings-field" type="url" maxlength="2048" placeholder="https://api.example.com/status" required :disabled="busy" /></label>
          <label>JSON 字段路径<input v-model="field" class="settings-field" maxlength="256" placeholder="例如 data.temperature，纯文本可留空" :disabled="busy" /></label>
          <label>屏幕标题（可选）<input v-model="label" class="settings-field" maxlength="20" placeholder="例如 室温" :disabled="busy" /></label>
          <label>刷新间隔（秒）<input v-model.number="interval" class="settings-field" type="number" min="15" max="3600" required :disabled="busy" /></label>
        </template>
        <label v-else-if="mode === 'text'">显示文字<textarea v-model="text" class="settings-field" rows="2" maxlength="50" placeholder="最多显示两行" required :disabled="busy" /></label>
        <p v-if="mode !== 'text'" class="screen-hint">保存后自动同步。动态显示需要支持该功能的固件、USB 连接和正在运行的 MultiPad。</p>
        <p v-if="error" class="screen-error" role="alert">{{ error }}</p>
        <div class="screen-actions">
          <button type="button" class="settings-button" @click="close">取消</button>
          <button v-if="mode === 'api'" type="button" class="settings-button" :disabled="busy" @click="generate(false)">测试 API</button>
          <button type="submit" class="settings-button is-primary" :disabled="busy">{{ busy ? '处理中…' : '保存设置' }}</button>
        </div>
      </div>
    </form>
    </main>
  </div>
</template>

<style scoped lang="scss">
.screen-window .screen-body {
  display:flex;
  flex-direction:column;
  flex:1;
  gap:12px;
  padding:14px 16px 16px;
  background:var(--settings-canvas);
}
.image-mode-hint { color:var(--settings-muted); font-size:13px; }
.screen-modes { display:flex; flex-wrap:wrap; gap:4px; }
.screen-modes button { background:transparent; color:var(--settings-muted); }
.screen-modes button[aria-pressed="true"] { background:var(--settings-selected); color:var(--settings-accent); }
.image-editor { flex:1; min-height:340px; position:relative; }
.screen-settings { display:grid; grid-template-columns:minmax(160px,.9fr) minmax(250px,1.1fr); gap:20px; align-items:start; padding:16px; border-radius:10px; background:var(--settings-surface); }
.screen-preview {
  width:100%;
  aspect-ratio:72 / 40;
  display:grid;
  place-items:center;
  background:#111a18;
  color:#d5ded9;
  border-radius:8px;
  overflow:hidden;
}
.screen-preview img { width:100%; image-rendering:pixelated; }
.screen-fields { display:grid; gap:11px; }
label { display:grid; gap:5px; font-size:13px; font-weight:600; }
textarea { resize:vertical; }
.screen-hint, .screen-error { font-size:12px; }
.screen-hint { color:var(--settings-muted); }
.screen-error { color:#923d38; }
.screen-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
@media(max-width:560px) { .screen-settings { grid-template-columns:1fr; } .screen-preview { max-width:250px; } }
</style>
