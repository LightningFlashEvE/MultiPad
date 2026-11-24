<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { drawGarden, drawHutchStraw, drawPetEffects, drawToyFactory, type PetAction } from './petScene'
import { drawRabbit, rabbitAtlasUrl } from './petAnimation'
import type { PetState } from './petDisplay'
import { petActions, petSceneLabels, petScenes, petToys } from '../../utils/petCatalog'

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
  const seasonTints = ['#96b86618', '#ffeb6f17', '#da72372b', '#bdddfd3d']
  const atlas = new Image()
  atlas.src = rabbitAtlasUrl
  let lastAction = -1
  let lastScene = -1
  let actionStart = 0
  let x = 128
  let direction = 1
  function frame(now: number) {
    const { action, x: position, hour, season, scene, activeToy, toyPhase } = props.state
    const factory = petScenes[scene] === 'toy_factory'
    if (lastScene !== scene) {
      if (factory) drawToyFactory(context!)
      else drawGarden(context!)
      lastScene = scene
    }
    const inHutch = petToys.find(toy => toy.wireId === activeToy)?.id === 'rabbit_hutch'
    const resting = inHutch && toyPhase === 2
    const stateAction = petActions[action] ?? 'idle'
    const clip: PetAction = stateAction === 'fetch' ? 'walk' :
      stateAction === 'fall' || stateAction === 'jump' ? 'react' : stateAction
    const roaming = clip === 'walk' || clip === 'run' || clip === 'flee'
    const target = props.connected ? position : inHutch ? 246 : roaming ? 160 + Math.sin(now / 1750) * 94 : x
    if (Math.abs(target - x) > 1) direction = target > x ? 1 : -1
    x += (target - x) * (inHutch && !props.connected ? .055 : .14)
    if (resting) { x = 246; direction = -1 }
    if (lastAction !== action) {
      lastAction = action
      actionStart = now
    }
    display!.drawImage(background, 0, 0)
    if (!factory) {
      display!.fillStyle = seasonTints[season] ?? seasonTints[0]
      display!.fillRect(0, 0, 320, 172)
      if (hour < 6 || hour >= 20) {
        display!.fillStyle = '#17274688'
        display!.fillRect(0, 0, 320, 172)
      }
    }
    const elapsed = now - actionStart
    drawRabbit(display!, atlas, Math.round(x), resting ? 142 : 139, direction, clip, elapsed)
    if (resting) drawHutchStraw(display!)
    drawPetEffects(display!, Math.round(x), direction, clip, elapsed, true)
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)
})
onUnmounted(() => cancelAnimationFrame(frameId))
</script>

<template>
  <canvas ref="canvas" width="320" height="172" :aria-label="petSceneLabels[petScenes[state.scene]] + '里的垂耳兔'" role="img" />
</template>

<style scoped>
canvas { display: block; width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
</style>
