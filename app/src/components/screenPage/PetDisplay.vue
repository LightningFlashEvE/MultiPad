<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { drawCarrotToy, drawGarden, drawPetEffects, drawNursery, drawNurseryHutch, drawNurseryLight, drawSceneClock, tintNursery, type PetAction } from './petScene'
import { drawRabbit, rabbitAtlasUrl } from './petAnimation'
import itemsUrl from '../../assets/pet/items.png'
import type { PetState } from './petDisplay'
import { petActions, petSceneLabels, petScenes, petToys } from '../../utils/petCatalog'

const props = defineProps<{ state: PetState; connected: boolean }>()
const canvas = ref<HTMLCanvasElement>()
const nurseryShadowRadii = [14, 19, 18, 12]
let frameId = 0

onMounted(() => {
  const display = canvas.value?.getContext('2d')
  const background = document.createElement('canvas')
  background.width = 320
  background.height = 172
  const context = background.getContext('2d')
  if (!display || !context) return
  const hutch = document.createElement('canvas')
  hutch.width = 81
  hutch.height = 74
  const hutchContext = hutch.getContext('2d')!
  hutchContext.translate(-205, -73)
  const items = new Image()
  items.src = itemsUrl
  display.imageSmoothingEnabled = false
  const seasonTints = ['#96b86618', '#ffeb6f17', '#da72372b', '#bdddfd3d']
  const atlas = new Image()
  atlas.src = rabbitAtlasUrl
  let lastAction = -1
  let lastScene = -1
  let lastLighting = -1
  let actionStart = 0
  let lastSample: PetState | undefined
  let lastFoods: PetState['foods']
  let lastDrop: number | undefined
  let sampleAt = 0
  let x = 128
  let direction = 1
  function frame(now: number) {
    const { action, x: position, hour, season, scene, activeToy, toyPhase } = props.state
    const { deployedToys, foods, toyDrop } = props.state
    if (lastSample !== props.state || lastFoods !== foods || lastDrop !== toyDrop) {
      lastSample = props.state
      lastFoods = foods
      lastDrop = toyDrop
      sampleAt = now
    }
    const nursery = petScenes[scene] === 'nursery'
    const liveNurseryLight = nursery && (!props.connected || props.state.minute !== undefined)
    const lighting = liveNurseryLight ? season * 24 + hour : -1
    if (lastScene !== scene || lastLighting !== lighting) {
      if (nursery) {
        drawNursery(context!)
        hutchContext.clearRect(205, 73, hutch.width, hutch.height)
        drawNurseryHutch(hutchContext)
        if (liveNurseryLight) {
          drawNurseryLight(context!, hour, season)
          hutchContext.save()
          hutchContext.globalCompositeOperation = 'source-atop'
          tintNursery(hutchContext, hour, season)
          hutchContext.restore()
        }
      } else drawGarden(context!)
      lastScene = scene
      lastLighting = lighting
    }
    const toy = petToys.find(toy => toy.wireId === activeToy)?.id
    const inHutch = toy === 'rabbit_hutch'
    const resting = inHutch && toyPhase === 2
    const stateAction = petActions[action] ?? 'idle'
    const clip: PetAction = stateAction === 'fetch' ? 'walk' :
      stateAction === 'fall' || stateAction === 'jump' ? 'react' : stateAction
    const roaming = clip === 'walk' || clip === 'run' || clip === 'flee'
    const playingCarrot = toy === 'carrot_toy'
    const followingFood = !!foods?.length && (stateAction === 'fetch' || stateAction === 'eat')
    const target = props.connected || followingFood ? position : inHutch ? 246 : playingCarrot ? 151 : roaming ? 160 + Math.sin(now / 1750) * 94 : x
    if (Math.abs(target - x) > 1) direction = target > x ? 1 : -1
    x += (target - x) * (inHutch && !props.connected ? .055 : .14)
    if (resting) { x = 246; direction = -1 }
    if (playingCarrot && toyPhase === 2) { x = 151; direction = 1 }
    if (lastAction !== action) {
      lastAction = action
      actionStart = now
    }
    display!.drawImage(background, 0, 0)
    if (!nursery) {
      display!.fillStyle = seasonTints[season] ?? seasonTints[0]
      display!.fillRect(0, 0, 320, 172)
      if (hour < 6 || hour >= 20) {
        display!.fillStyle = '#17274688'
        display!.fillRect(0, 0, 320, 172)
      }
      drawPetEffects(display!, Math.round(x), direction, clip, now - actionStart, false,
        !activeToy && !props.state.fruit)
    }
    if (nursery && toyPhase !== 2) {
      display!.fillStyle = 'rgba(130, 108, 107, .2)'
      nurseryShadowRadii.forEach((radius, row) =>
        display!.fillRect(Math.round(x) - radius, 138 + row, radius * 2, 1))
    }
    const elapsed = now - actionStart
    const deployed = deployedToys?.[scene] ?? (nursery ? 1 : 0)
    const drop = Math.min(1, (toyDrop ?? 100) / 100 + (now - sampleAt) / 650)
    const dy = -Math.round(146 * (1 - drop))
    if (deployed === 1) display!.drawImage(hutch, 205, 73 + dy)
    if (deployed === 2) {
      display!.save()
      display!.translate(0, dy)
      drawCarrotToy(display!, playingCarrot && toyPhase === 2, elapsed)
      display!.restore()
    }
    drawRabbit(display!, atlas, Math.round(x), resting ? 142 : 139, direction, clip, elapsed)
    if (resting) display!.drawImage(hutch, 21, 63, 40, 4, 226, 136, 40, 4)
    if (foods && items.complete && items.naturalWidth) {
      for (const food of foods) {
        if (food.id < 1 || food.id > 8) continue
        // The device reports the centre of each falling fruit; advance its arc between USB samples.
        const initial = Math.max(0, Math.min(1, (food.y + 9) / 138))
        const t = Math.min(1, (Math.sqrt(1 + 8 * initial) - 1) / 2 + (now - sampleAt) / 650)
        const y = food.stage === 0 ? Math.round(-9 + 69 * t * (1 + t)) : food.y
        display!.drawImage(items, (food.id - 1) * 16 + 3, 3, 9, 9, food.x - 9, y - 9, 18, 18)
      }
    }
    drawPetEffects(display!, Math.round(x), direction, clip, elapsed, true)
    drawSceneClock(display!, hour, props.state.minute ?? 0)
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
