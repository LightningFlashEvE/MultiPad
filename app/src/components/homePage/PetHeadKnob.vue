<script setup lang="ts">
import { onBeforeUnmount } from 'vue'

const emit = defineEmits<{ pat: [gesture: number]; switchMode: [] }>()
let press: { id: number; started: number; angle?: number; rotation: number; turned: boolean } | undefined
let lastTurn = 0
let lastDirection = 0

function angle(event: PointerEvent) {
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - r.left - r.width / 2, y = event.clientY - r.top - r.height / 2
  return Math.hypot(x, y) < 14 ? undefined : Math.atan2(y, x)
}

function down(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || press) return
  press = { id: event.pointerId, started: performance.now(), angle: angle(event), rotation: 0, turned: false }
  const button = event.currentTarget as HTMLButtonElement
  button.setPointerCapture(event.pointerId)
}

function turn(direction: 1 | 2) {
  if (!press) return
  const now = performance.now()
  if (press.turned && direction === lastDirection && now - lastTurn < 90) return
  emit('pat', press.turned ? direction + 2 : direction)
  press.turned = true
  lastTurn = now
  lastDirection = direction
}

function move(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return
  const next = angle(event)
  if (press.angle !== undefined && next !== undefined) {
    const delta = next - press.angle
    press.rotation += Math.atan2(Math.sin(delta), Math.cos(delta))
    if (Math.abs(press.rotation) >= Math.PI / 12) {
      turn(press.rotation > 0 ? 1 : 2)
      press.rotation = 0
    }
  }
  press.angle = next
}

function wheel(event: WheelEvent) {
  if (!press) return
  const delta = event.deltaY || event.deltaX
  if (!delta) return
  event.preventDefault()
  turn(delta > 0 ? 1 : 2)
}

function up(event: PointerEvent) {
  if (press?.id !== event.pointerId) return
  const { started, turned } = press
  press = undefined
  if (turned) return
  if (performance.now() - started >= 1200) emit('switchMode')
  else emit('pat', 0)
}

function cancel() { press = undefined }
onBeforeUnmount(cancel)
</script>

<template>
  <button type="button" class="rotary rotary-large head-knob"
    aria-label="旋钮 3，摸兔头" title="点击摸头；按住拖转或滚动滚轮可来回抚摸。长按不转，松开后切换模式。"
    @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel"
    @lostpointercapture="cancel" @wheel="wheel" @click.stop="event => { if (event.detail === 0) emit('pat', 0) }">
    旋钮 3<small>摸兔头</small>
  </button>
</template>

<style scoped>
.head-knob { touch-action: none; user-select: none; }
.head-knob small { display: block; margin-top: 4px; font: inherit; font-size: 12px; font-weight: 400; }
</style>
