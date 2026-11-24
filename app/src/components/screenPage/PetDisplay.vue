<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { drawGarden, type PetAction } from './petScene'
import { drawRabbit, rabbitAtlasUrl } from './petAnimation'
import type { PetState } from './petDisplay'

const props = defineProps<{ state: PetState; connected: boolean }>()
const canvas = ref<HTMLCanvasElement>()
let frameId = 0

onMounted(() => {
  const display = canvas.value?.getContext('2d')
  const background = document.createElement('canvas')
  background.width = 320
  background.height = 172
  const context = background.getContext('2d')
  if (!display || !context) return
  drawGarden(context)
  const seasonTints = ['#96b86618', '#ffeb6f17', '#da72372b', '#bdddfd3d']
  const atlas = new Image()
  atlas.src = rabbitAtlasUrl
  const actions: PetAction[] = ['idle', 'walk', 'sleep', 'eat', 'idle', 'walk', 'walk', 'react', 'idle', 'walk', 'idle']
  let lastAction = -1
  let actionStart = 0
  let x = 128
  let direction = 1
  function frame(now: number) {
    const { action, x: position, hour, season } = props.state
    const fallback = 160 + Math.sin(now / 1750) * 94
    const target = props.connected && position ? position : action === 2 ? x : fallback
    if (Math.abs(target - x) > 1) direction = target > x ? 1 : -1
    x += (target - x) * .14
    if (lastAction !== action) {
      lastAction = action
      actionStart = now
    }
    display!.drawImage(background, 0, 0)
    display!.fillStyle = seasonTints[season] ?? seasonTints[0]
    display!.fillRect(0, 0, 320, 172)
    if (hour < 6 || hour >= 20) {
      display!.fillStyle = '#17274688'
      display!.fillRect(0, 0, 320, 172)
    }
    drawRabbit(display!, atlas, Math.round(x), 139, direction, actions[action] ?? 'idle', now - actionStart)
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)
})
onUnmounted(() => cancelAnimationFrame(frameId))
</script>

<template>
  <canvas ref="canvas" width="320" height="172" aria-label="垂耳兔花园" role="img" />
</template>

<style scoped>
canvas { display: block; width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
</style>
