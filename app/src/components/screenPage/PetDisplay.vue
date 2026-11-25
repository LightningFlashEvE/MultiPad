<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { drawCarrotToy, drawGarden, drawPetEffects, drawNursery, drawNurseryHutch, drawNurseryTable, drawNurseryLight, drawPendantLamp, drawSceneClock, tintNursery, type PetAction } from './petScene'
import { bitePosition, drawRabbit, drawRabbitHeadPat, rabbitAtlasUrl } from './petAnimation'
import { patPhase } from './petHeadPat'
import itemsUrl from '../../assets/pet/items.png'
import type { HutchPosition, PetState } from './petDisplay'
import { binkyMotion, createPetActionClock, petActions, petFurniture, petLampIsLit, petRunDurationMs, petRunPosition, petSceneLabels, petScenes, petWarehouseGeneration,
  type PetFurniture, type PetFurnitureId } from '../../utils/petCatalog'

const props = defineProps<{ state: PetState; connected: boolean; editableDecoration?: boolean; decorationBusy?: boolean;
  decorationGeneration?: number; selectedFurniture?: PetFurnitureId }>()
const emit = defineEmits<{ moveFurniture: [id: PetFurnitureId, position: HutchPosition]; selectFurniture: [id: PetFurnitureId] }>()
const canvas = ref<HTMLCanvasElement>()
const dragging = ref<{ id: PetFurnitureId; position: HutchPosition }>()
const handles = computed(() => !props.editableDecoration || props.state.scene !== 1 ? [] :
  petFurniture.filter(item => (props.decorationGeneration ?? petWarehouseGeneration) >= item.generation &&
    (!props.state.warehouse || Boolean(props.state.warehouse.owned & item.ownedFlag)) &&
    (item.id !== 'lamp' || props.state.pendantLamp)))
let grab: { item: PetFurniture; pointerId: number; x: number; y: number; target: HTMLElement } | undefined

function location(item: PetFurniture): HutchPosition {
  if (dragging.value?.id === item.id) return dragging.value.position
  return (item.id === 'hutch' ? props.state.hutchPosition : item.id === 'table' ? props.state.tablePosition : props.state.lampPosition)
    ?? item.position
}

function handleStyle(item: PetFurniture) {
  const position = location(item)
  return { left: (position.x + item.offset.x) / 320 * 100 + '%', top: (position.y + item.offset.y) / 172 * 100 + '%',
    width: item.size.width / 320 * 100 + '%', height: item.size.height / 172 * 100 + '%' }
}

function limitPosition(item: PetFurniture, x: number, y: number): HutchPosition {
  const { minX, maxX, minY, maxY } = item.bounds
  return { x: Math.max(minX, Math.min(maxX, Math.round(x))), y: Math.max(minY, Math.min(maxY, Math.round(y))) }
}

function scenePoint(event: PointerEvent) {
  const bounds = canvas.value!.getBoundingClientRect()
  return { x: (event.clientX - bounds.left) * 320 / bounds.width, y: (event.clientY - bounds.top) * 172 / bounds.height }
}

function startDrag(event: PointerEvent, item: PetFurniture) {
  if (props.decorationBusy || !event.isPrimary || event.button !== 0 || grab) return
  const pos = scenePoint(event)
  const from = location(item)
  const target = event.currentTarget as HTMLElement
  grab = { item, pointerId: event.pointerId, x: pos.x - from.x, y: pos.y - from.y, target }
  dragging.value = { id: item.id, position: { ...from } }
  target.setPointerCapture(event.pointerId)
  emit('selectFurniture', item.id)
}

function moveDrag(event: PointerEvent) {
  if (!grab || grab.pointerId !== event.pointerId) return
  const pos = scenePoint(event)
  dragging.value = { id: grab.item.id, position: limitPosition(grab.item, pos.x - grab.x, pos.y - grab.y) }
}

function cancelDrag() {
  const previous = grab
  grab = undefined
  dragging.value = undefined
  if (previous?.target.hasPointerCapture(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId)
}

function savePosition(item: PetFurniture, position: HutchPosition) {
  const current = location(item)
  if (!props.decorationBusy && (position.x !== current.x || position.y !== current.y))
    emit('moveFurniture', item.id, position)
}

function endDrag(event: PointerEvent) {
  if (grab?.pointerId !== event.pointerId) return
  moveDrag(event)
  const item = grab.item
  const position = dragging.value?.position
  cancelDrag()
  if (position) savePosition(item, position)
}

const arrowSteps: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
}
function nudge(event: KeyboardEvent, item: PetFurniture) {
  if (event.key === 'Escape' && grab) { event.preventDefault(); cancelDrag(); return }
  const step = arrowSteps[event.key]
  if (!step || grab || props.decorationBusy) return
  event.preventDefault()
  const current = location(item)
  const size = event.shiftKey ? 8 : 1
  emit('selectFurniture', item.id)
  savePosition(item, limitPosition(item, current.x + step[0] * size, current.y + step[1] * size))
}
watch(handles, items => { if (grab && !items.includes(grab.item)) cancelDrag() })
watch(() => props.decorationBusy, busy => { if (busy) cancelDrag() })

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
  const table = document.createElement('canvas')
  table.width = 76
  table.height = 61
  const tableContext = table.getContext('2d')!
  tableContext.translate(-7, -66)
  const items = new Image()
  items.src = itemsUrl
  display.imageSmoothingEnabled = false
  const seasonTints = ['#96b86618', '#ffeb6f17', '#da72372b', '#bdddfd3d']
  const atlas = new Image()
  atlas.src = rabbitAtlasUrl
  let lastScene = -1
  let lastLighting = -1
  const actionClock = createPetActionClock()
  let lastSample: PetState | undefined
  let lastFoods: PetState['foods']
  let lastDrop: number | undefined
  let sampleAt = 0
  let frameAt = 0
  let runFacing: number | undefined
  let lastPatState: PetState | undefined
  let lastRemaining = 0, lastPatKind = 0
  let patStarted = 0, patUntil = 0
  let x = 128
  let direction = 1
  function frame(now: number) {
    const frameDuration = frameAt ? Math.min(now - frameAt, 80) : 16
    frameAt = now
    const { action, x: position, hour, season, scene, activeToy, toyPhase } = props.state
    const { deployedToys, foods, toyDrop } = props.state
    const remaining = props.state.headPatRemaining ?? 0
    const patKind = props.state.headPatKind ?? 0
    if (props.state !== lastPatState || remaining !== lastRemaining || patKind !== lastPatKind) {
      if (remaining && now >= patUntil) patStarted = now - (1200 - remaining)
      patUntil = remaining ? now + remaining : 0
      lastRemaining = remaining
      lastPatState = props.state
      lastPatKind = patKind
    }
    if (lastSample !== props.state || lastFoods !== foods || lastDrop !== toyDrop) {
      lastSample = props.state
      lastFoods = foods
      lastDrop = toyDrop
      sampleAt = now
    }
    const nursery = petScenes[scene] === 'nursery'
    const minute = props.state.minute ?? 0
    const lampInstalled = nursery && props.state.pendantLamp === true
    const lampLit = lampInstalled && (props.state.pendantLampLit ?? petLampIsLit(hour))
    const lighting = ((season * 24 + hour) * 60 + minute) * 4 + Number(lampInstalled) * 2 + Number(lampLit)
    if (lastScene !== scene || lastLighting !== lighting) {
      if (nursery) {
        drawNursery(context!, hour, minute)
        hutchContext.clearRect(205, 73, hutch.width, hutch.height)
        drawNurseryHutch(hutchContext)
        tableContext.clearRect(7, 66, table.width, table.height)
        drawNurseryTable(tableContext)
        drawNurseryLight(context!, hour, minute, season, lampLit)
        hutchContext.save()
        hutchContext.globalCompositeOperation = 'source-atop'
        tintNursery(hutchContext, hour, minute, season, lampLit)
        hutchContext.restore()
        tableContext.save()
        tableContext.globalCompositeOperation = 'source-atop'
        tintNursery(tableContext, hour, minute, season, lampLit)
        tableContext.restore()
      } else drawGarden(context!, hour, minute)
      lastScene = scene
      lastLighting = lighting
    }
    const fixedDecoration = !!props.state.hutchPosition
    const home = location(petFurniture[0])
    const inHutch = nursery && activeToy === 1
    const resting = inHutch && toyPhase === 2
    const stateAction = petActions[action] ?? 'idle'
    const touched = now < patUntil && props.state.headPatPhase !== undefined
    const clip: PetAction = touched && stateAction !== 'sleep' ? 'idle' : stateAction === 'fetch' ? 'walk' :
      stateAction === 'fall' || stateAction === 'jump' ? 'react' : stateAction
    const running = clip === 'run'
    const roaming = clip === 'walk' || clip === 'flee'
    const playingCarrot = activeToy === 2
    const followingFood = !!foods?.length && (stateAction === 'fetch' || stateAction === 'eat')
    const wireAge = props.state.actionAgeMs
    const elapsed = actionClock(action, wireAge, touched, now)
    const facing = props.state.facing ?? direction
    const target = running ? (props.connected
      ? petRunPosition(position, facing, Math.min(now - sampleAt, 180, petRunDurationMs - (wireAge ?? 0)))
      : position)
      : props.connected || followingFood || activeToy === 3 || (props.state.rabbitY ?? 139) < 139 ? position
        : inHutch ? home.x : playingCarrot ? 151 : roaming ? 160 + Math.sin(now / 1750) * 94 : x
    if ((props.connected || running) && props.state.facing) direction = props.state.facing
    else if (!touched && Math.abs(target - x) > 1) direction = target > x ? 1 : -1
    const eating = foods?.find(food => food.stage === 2)
    if (eating && stateAction === 'eat') {
      x = position
      direction = eating.x >= x ? 1 : -1
    } else if (touched && props.connected) x = position
    else if (running) {
      const next = x + (target - x) * (1 - Math.exp(-frameDuration / 58))
      x = runFacing !== facing ? next : facing > 0 ? Math.max(x, next) : Math.min(x, next)
    } else if (!touched) x += (target - x) * (inHutch && !props.connected ? .055 : .14)
    runFacing = running ? facing : undefined
    if (activeToy === 3 && toyPhase === 2) { x = position; direction = -1 }
    if (resting) { x = home.x; direction = -1 }
    if (playingCarrot && toyPhase === 2) { x = 151; direction = 1 }
    let rabbitY = resting ? home.y : (props.state.rabbitY ?? 139)
    const shadowY = rabbitY
    if (stateAction === 'binky' && wireAge !== undefined) {
      const observed = binkyMotion(wireAge), animated = binkyMotion(elapsed)
      const originalFacing = (props.state.facing ?? 1) * observed.facing
      x = position + originalFacing * (animated.travel - observed.travel)
      direction = originalFacing * animated.facing
      rabbitY -= animated.lift
    }
    display!.drawImage(background, 0, 0)
    if (nursery) {
      const place = location(petFurniture[1])
      display!.drawImage(table, place.x - 91, place.y - 50)
      if (lampInstalled) {
        const lamp = location(petFurniture[2])
        display!.save()
        display!.translate(lamp.x - 222, lamp.y)
        drawPendantLamp(display!, lampLit)
        display!.restore()
      }
    }
    if (!nursery) {
      display!.fillStyle = seasonTints[season] ?? seasonTints[0]
      display!.fillRect(0, 0, 320, 172)
      if (hour < 6 || hour >= 20) {
        display!.fillStyle = '#17274688'
        display!.fillRect(0, 0, 320, 172)
      }
      drawPetEffects(display!, Math.round(x), direction, clip, elapsed, false,
        !activeToy && !props.state.fruit)
    }
    if (nursery && toyPhase !== 2) {
      display!.fillStyle = 'rgba(130, 108, 107, .2)'
      nurseryShadowRadii.forEach((radius, row) =>
        display!.fillRect(Math.round(x) - radius, shadowY - 1 + row, radius * 2, 1))
    }
    const deployed = deployedToys?.[scene] ?? (nursery ? 1 : 0)
    const drop = Math.min(1, (toyDrop ?? 100) / 100 + (now - sampleAt) / 650)
    const dy = -Math.round(146 * (1 - drop))
    if (nursery && (fixedDecoration || deployed === 1))
      display!.drawImage(hutch, home.x - 41, home.y - 69 + (fixedDecoration ? 0 : dy))
    if (deployed === 2) {
      display!.save()
      display!.translate(0, dy)
      drawCarrotToy(display!, playingCarrot && toyPhase === 2, elapsed)
      display!.restore()
    }
    const phase = now < patUntil ? (patKind && props.state.headPatPhase !== undefined && patUntil - now > 200
      ? props.state.headPatPhase : patPhase(now - patStarted, patUntil - now)) : undefined
    const drawFood = (id: number, cx: number, cy: number) =>
      display!.drawImage(items, (id - 1) * 16 + 3, 3, 9, 9, cx - 9, cy - 9, 18, 18)
    if (foods && items.complete && items.naturalWidth) {
      for (const food of foods) {
        if (food.stage === 2 || food.id < 1 || food.id > 8) continue
        // The device reports the centre of each falling fruit; advance its arc between USB samples.
        const initial = Math.max(0, Math.min(1, (food.y + 9) / 138))
        const t = Math.min(1, (Math.sqrt(1 + 8 * initial) - 1) / 2 + (now - sampleAt) / 650)
        const y = food.stage === 0 ? Math.round(-9 + 69 * t * (1 + t)) : food.y
        drawFood(food.id, food.x, y)
      }
    }
    const pose = drawRabbit(display!, atlas, Math.round(x), rabbitY, direction, clip, elapsed, phase)
    if (resting) display!.drawImage(hutch, 21, 63, 40, 4, home.x - 20, home.y - 6, 40, 4)
    if (eating && items.complete && items.naturalWidth) {
      const bite = pose === undefined ? undefined : bitePosition(Math.round(x), rabbitY, direction, pose)
      drawFood(eating.id, bite?.x ?? eating.x, bite?.y ?? eating.y)
    }
    display!.save()
    display!.translate(0, rabbitY - (resting ? 142 : 139))
    drawPetEffects(display!, Math.round(x), direction, clip, elapsed, true)
    display!.restore()
    if (phase !== undefined && pose !== undefined)
      drawRabbitHeadPat(display!, Math.round(x), rabbitY, direction, pose, touched && patKind ? 1 : patKind, phase)
    drawSceneClock(display!, hour, props.state.minute ?? 0)
    frameId = requestAnimationFrame(frame)
  }
  frameId = requestAnimationFrame(frame)
})
onUnmounted(() => cancelAnimationFrame(frameId))
</script>

<template>
  <div class="pet-scene">
    <canvas ref="canvas" width="320" height="172" :aria-label="petSceneLabels[petScenes[state.scene]] + '里的垂耳兔'" role="img" />
    <button v-for="item in handles" :key="item.id" class="furniture-handle"
      :class="{ selected: selectedFurniture === item.id, dragging: dragging?.id === item.id }" :style="handleStyle(item)"
      type="button" :aria-disabled="decorationBusy" :aria-label="'移动' + item.label" :title="'拖动' + item.label + '，或用方向键微调'"
      @pointerdown="startDrag($event, item)" @pointermove="moveDrag" @pointerup="endDrag"
      @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" @keydown="nudge($event, item)"></button>
  </div>
</template>

<style scoped>
.pet-scene { position: relative; width: 100%; aspect-ratio: 320 / 172; overflow: hidden; border-radius: inherit; }
canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; }
.pet-scene .furniture-handle { position:absolute; box-sizing:border-box;
  padding:0; margin:0; background:transparent; border:1px dashed rgb(39 86 75 / 70%);
  border-radius:9px; cursor:grab; touch-action:none; }
.furniture-handle.selected { z-index:1; border-color:#276550; }
.furniture-handle:hover,.furniture-handle:focus-visible,.furniture-handle.dragging { outline:2px solid #276550; outline-offset:-2px; }
.furniture-handle.dragging { cursor:grabbing; }
</style>
