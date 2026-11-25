<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, ref } from 'vue'

import { editorConfig } from '../../utils/theme'
import 'tui-image-editor/dist/tui-image-editor.css'
import ImageEditor from 'tui-image-editor/dist/tui-image-editor.js'
import { XBox } from 'ilx1-x-box'
import type { ScreenFrame } from './screenContent'

const win = window as any
const props = defineProps<{ screen: number; initialImage?: string }>()
const emit = defineEmits<{ save: [frame: ScreenFrame] }>()
const fileInput = ref<HTMLInputElement>()
const instance = shallowRef<{
  loadImageFromURL: (url: string, name: string) => Promise<unknown>
  addText: (text: string, options: object) => Promise<unknown>
  toDataURL: () => string
  destroy: () => void
}>()

onMounted(() => {
  const initial = props.initialImage
  const editor = new ImageEditor(document.querySelector('#editor'), {
    ...editorConfig,
    includeUI: {
      ...editorConfig.includeUI,
      loadImage: initial ? { path: `data:image/png;base64,${initial}`, name: 'screen' } : editorConfig.includeUI.loadImage
    }
  })
  instance.value = editor
})
onUnmounted(() => instance.value?.destroy())

async function chooseImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const editor = instance.value
  if (!file || !editor) return
  const url = URL.createObjectURL(file)
  try {
    await editor.loadImageFromURL(url, file.name)
  } catch {
    XBox.popMes('读取图片失败，请重新选图。')
  } finally {
    URL.revokeObjectURL(url)
  }
}

const imgArr: Array<string> = ['./img/black.png', './img/blank.png', './img/1.jpg', './img/2.png', './img/3.png', './img/4.png', './img/5.png' ]
const curImg = ref<number>(0)
// 切换反色背景
const switchBack = () => {
  curImg.value < 6 ? curImg.value ++ : curImg.value = 0
  // console.info(curImg.value)
  let img = imgArr[curImg.value]
  let color = curImg.value == 1 ? '#000000' : '#ffffff';

  const editor = instance.value
  editor?.loadImageFromURL(img, 'blank').then(() => {
    return editor.addText('', {
      position: {},
      styles: {
        fill: color,
        fontSize: 85,
        fontFamily: '',
        fontStyle: '',
        fontWeight: '',
        underline: ''
      }
    })
  }).catch(() => XBox.popMes('切换背景失败'))
}

// 编辑信息提交
const editorCommit = async () => {
  if (!instance.value || coverShow.value) return
  XBox.popMes('处理数据中...')
  coverShow.value = true
  try {
    const picBase64Str = instance.value.toDataURL()
    const monochrome = props.screen !== 0
    const width = monochrome ? 72 : 320
    const height = monochrome ? 40 : 172
    const mode = Number(monochrome)
    const data = await win.myApi.resizeImage(width, height, picBase64Str, mode)
    const arrData = await win.myApi.generateResultArray(data, 120, 1, 2, 0, 0, mode)
    if (arrData.length !== width * height * (monochrome ? 1 / 8 : 2)) {
      throw new Error('Unexpected screen data size')
    }
    emit('save', { baseData: data, buffData: arrData })
  } catch (error) {
    console.error(error)
    XBox.popMes('屏幕图片处理失败，请重新选图')
  } finally {
    coverShow.value = false
  }
}

const closeWindow = () => {
  win.myApi.closeWindow()
}

const coverShow = ref<boolean>(false)
</script>

<template>
  <div class="editor-workspace">
    <div id="cover" v-if="coverShow"></div>
    <div id="editor"></div>
    <div id="tools-bar">
      <div class="image-sources">
        <input ref="fileInput" type="file" accept="image/*" hidden @change="chooseImage">
        <button class="settings-button" type="button" :disabled="coverShow" @click="fileInput?.click()">选择图片</button>
        <button class="settings-button" type="button" :disabled="coverShow" @click="switchBack">切换底图</button>
      </div>
      <div>
        <button class="settings-button" type="button" :disabled="coverShow" @click="closeWindow">取消</button>
        <button class="settings-button is-primary" type="button" :disabled="coverShow" @click="editorCommit">保存图片</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.editor-workspace { width:100%; height:100%; position:relative; display:grid; grid-template-rows:minmax(0,1fr) auto; border-radius:10px; background:var(--settings-surface); overflow:hidden; }
#cover { position:absolute; inset:0; background:#182b2452; z-index:10000; }
#editor { min-height:0; }
#editor :deep(.tui-image-editor-header-buttons) { display:none; }
#tools-bar { display:flex; justify-content:space-between; flex-wrap:wrap; align-items:center; gap:8px; padding:9px 10px; border-top:1px solid var(--settings-line); }
#tools-bar > div { display:flex; gap:6px; margin-left:auto; }
#tools-bar > .image-sources { margin-left:0; }
</style>
