<script setup lang="ts">
import WindowTitle from '../components/tools/WindowTitle.vue'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import PopBox from '../components/tools/PopBox.vue'
import AppInfo from '../components/homePage/AppInfo.vue'
import ContextMenu from '../views/contextMenu.vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '../stores/configStore'
import { useMenuStore } from '../stores/menuStore'
import { parseMenuConfig, testConnection, loadMenu, resetData } from '../utils/dataHandle'
import { sendWorkConfiguration, workLayerPayload, type WorkLayer } from '../utils/workConfigSync'
// import { setItem, getItem } from '@/utils/storage'
import { XBox } from 'ilx1-x-box'
import { renderDeviceScreens, type DeviceScreens } from '../utils/deviceScreenFormat'
import type { DeviceButtons } from '../utils/deviceButtonState'
import { createLiveScreens } from '../components/screenPage/liveScreens'
import { renderScreenContent, type ScreenFrame } from '../components/screenPage/screenContent'
import PetDisplay from '../components/screenPage/PetDisplay.vue'
import PetAiActivity from '../components/homePage/PetAiActivity.vue'
import PetHeadKnob from '../components/homePage/PetHeadKnob.vue'
import { createPetItemPreview, previewCare } from '../components/screenPage/petItemPreview'
import PerformanceDisplay from '../components/screenPage/PerformanceDisplay.vue'
import { petParameters, petParameterContent, petStats, type HutchPosition, type PetParameter, type PetState } from '../components/screenPage/petDisplay'
import { invertPetEnergy, petScenes, petItems, petStateGeneration,
  petLampCommand, petToggleLampCommand, petLampIsLit, petLampState, isHutchPosition, defaultHutchPosition } from '../utils/petCatalog'
import { furniturePositionValid, newPetWarehouse, petBuySnackCommand, petFruitIds, petFruitLabels, petFruitStockMessage, petOutOfStockStatus, petFurniture, petMaxCoins, petMaxStock,
  petSnackPack, petSnackPrice, petStarterItems, petWarehouseBytes, readPetWarehouse, type PetFurnitureId, type PetPosition } from '../utils/petCatalog'
import type { ParameterPair, PetSettingsAction, PetSettingsScreen, PetSettingsSnapshot } from '../utils/petSettings'

const router = useRouter()
const win = window as any
const configStore = useConfigStore()
const menuStore = useMenuStore()
const popBoxRef = ref<HTMLElement | null>(null)
let liveTimer: ReturnType<typeof setInterval> | undefined
let petTimer: ReturnType<typeof setInterval> | undefined
let petMotionTimer: ReturnType<typeof setInterval> | undefined
let petTask: Promise<void> | undefined
let petSession: string | undefined
let requestedMode: { mode: 'work' | 'pet'; session: string } | undefined
const appMode = ref<'work' | 'pet'>('work')
const petState = ref<PetState>({ active: false, action: 1, x: 128, fruit: 0, hour: 18, season: 0, queue: 0,
  scene: 0, activeToy: 0, toyPhase: 0, stats: { ...previewCare }, deployedToys: [0, 0], foods: [],
  hutchPosition: { ...defaultHutchPosition } })
const petLinked = ref(false)
const petNotice = ref('')
const interactionNotice = ref('')
const interacting = ref(false)
const generation = ref(0)
const legacyPet = computed(() => petLinked.value && generation.value < 2)
const bindings = ref<number[]>()
const fruitKeys = [1, 2, 3, 4, 5, 6, 7, 8]
const previewKeys = ref([...fruitKeys])
const keyItems = computed(() => (bindings.value ?? (petLinked.value ? fruitKeys : previewKeys.value))
  .map(id => petItems.find(item => item.itemId === id)))
const followClock = ref(false)
const bedtime = ref(false)
let pendingClock: boolean | undefined
let nextClockRetry = 0
let offlineHutch: HutchPosition = { ...defaultHutchPosition }
let offlineLamp = false
let offlineLampLit: boolean | undefined
const offlineWarehouse = ref(newPetWarehouse())
const warehouse = computed(() => petLinked.value ? petState.value.warehouse : offlineWarehouse.value)
const offlineFurniture = { table: { ...petFurniture[1].position }, lamp: { ...petFurniture[2].position } } as Record<'table' | 'lamp', PetPosition>
function saveWarehouse() {
  win.myApi.storageMenu('petWarehousePreview', JSON.stringify(offlineWarehouse.value))
}
const petParameterIds = ref<[ParameterPair, ParameterPair]>([['satiety','energy'], ['mood','affection']])
const petImages = ref(['', ''])
const performanceValues = ref<number[]>([])
const performancePreview = ref<{ menu: number; values: number[] }>()
const performanceUnavailable = ref(false)
const petSettingsView = ref<PetSettingsSnapshot['view']>()
const isSleeping = computed(() => bedtime.value || (petLinked.value && generation.value < 3 && petState.value.action === 2))
let petSettingsRevision = 0
let stopPetSettingsCommand: (() => void) | undefined
let stopPetSettingsClose: (() => void) | undefined
const pendingScene = new Map<number, number>()
let offlineBackground: number | undefined
const previewWorld = createPetItemPreview(() => petState.value, value => { bedtime.value = value }, () => {
  offlineWarehouse.value.coins = Math.min(petMaxCoins, offlineWarehouse.value.coins + 2)
  saveWarehouse()
})
const hasPetPayload = (p?: Uint8Array) => p && petStateGeneration(p) !== 0
watch(() => petState.value.hour, (hour, previous) => {
  if (!petLinked.value && petLampIsLit(hour) !== petLampIsLit(previous)) {
    offlineLampLit = offlineLamp && petLampIsLit(hour)
    petState.value.pendantLampLit = offlineLampLit
  }
}, { flush: 'sync' })
watch(petLinked, linked => {
  if (!linked) {
    generation.value = 0
    bindings.value = undefined
    bedtime.value = false
    Object.assign(petState.value, { active: false, stats: { ...(petState.value.stats ?? previewCare) }, activeToy: 0, toyPhase: 0, action: 1,
      deployedToys: [0, 0], foods: [], toyDrop: 100, queue: 0, fruit: 0, headPatRemaining: 0, hutchPosition: { ...offlineHutch },
      tablePosition: offlineFurniture.table, lampPosition: offlineFurniture.lamp, pendantLamp: offlineLamp,
      pendantLampLit: offlineLampLit, pendantLampManual: undefined })
  }
})

function storeMode() {
  win.myApi.storageMenu('displayMode', appMode.value)
}

async function restoreDisplayMode() {
  const savedMode = await win.myApi.getMenu('displayMode')
  if (!petLinked.value && (savedMode === 'pet' || savedMode === 'work')) appMode.value = savedMode
}

function setAppMode(mode: 'work' | 'pet') {
  if (appMode.value === mode) return
  requestedMode = conState.value && petLinked.value && petSession ? { mode, session: petSession } : undefined
  appMode.value = mode
  storeMode()
  if (mode === 'work') refreshDeviceScreens()
  refreshPetDevice()
  liveScreens.tick()
}

function applyPetReply(reply: { session?: string; payload: Uint8Array }) {
  const p = reply.payload
  const previousScene = petState.value.scene
  const previousFollow = followClock.value
  if (!petLinked.value) previewWorld.reset()
  petSession = reply.session
  petLinked.value = true
  petNotice.value = ''
  generation.value = petStateGeneration(p)
  const savedInventory = readPetWarehouse(p, generation.value)
  const lamp = petLampState(p[27], p[9])
  const ageOffset = p.length - 3 - (savedInventory ? petWarehouseBytes : 0)
  const world = generation.value >= 3
  const decorationOffset = 33 + 6 * p[32]
  bindings.value = world ? Array.from(p.slice(19, 27)) : undefined
  if (bindings.value && bindings.value.some((id, i) => id !== previewKeys.value[i])) {
    previewKeys.value = [...bindings.value]
    win.myApi.storageMenu('petKeyPreview', JSON.stringify(previewKeys.value))
  }
  followClock.value = world && Boolean(p[27] & 1)
  bedtime.value = world && Boolean(p[27] & 2)
  if (followClock.value) pendingScene.delete(4)
  petState.value = { active: p[0] === 1, action: p[1], x: p[2] | (p[3] << 8), fruit: p[8],
    hour: pendingScene.get(4) ?? p[9], season: pendingScene.get(5) ?? p[10], queue: p[11],
    minute: world ? p[28] : undefined,
    stats: p.length >= 19 ? { satiety: p[12], energy: invertPetEnergy(p[13]), mood: p[14], affection: p[15] } : undefined,
    scene: p.length >= 19 ? p[16] : 0,
    activeToy: p[17] ?? 0, toyPhase: p[18] ?? 0,
    pendantLamp: lamp.installed, pendantLampLit: lamp.lit, pendantLampManual: lamp.manual,
    tablePosition: savedInventory?.table, lampPosition: savedInventory?.lamp, warehouse: savedInventory?.warehouse,
    hutchPosition: generation.value >= 4 ? { x: p[decorationOffset] | p[decorationOffset + 1] << 8, y: p[decorationOffset + 2] } : undefined,
    rabbitY: generation.value >= 4 ? p[decorationOffset + 3] : undefined,
    headPatRemaining: generation.value >= 5 ? p[decorationOffset + 4] * 10 : undefined,
    facing: generation.value >= 6 ? (p[decorationOffset + 7] & 1 ? 1 : -1) : undefined,
    actionAgeMs: generation.value >= 8 ? p[ageOffset] + 256 * p[ageOffset + 1] : undefined,
    headPatPhase: generation.value >= 6 ? p[decorationOffset + 6] : undefined,
    headPatKind: generation.value >= 5 ? p[decorationOffset + 5] : undefined,
    deployedToys: world ? [p[29], p[30]] : undefined, toyDrop: world ? p[31] : undefined,
    foods: world ? Array.from({ length: p[32] }, (_, i) => {
      const offset = 33 + 6 * i
      const y = p[offset + 3] | p[offset + 4] << 8
      return { id: p[offset], x: p[offset + 1] | p[offset + 2] << 8, y: (y << 16) >> 16, stage: p[offset + 5] }
    }) : undefined }
  if (p.length >= 19 && (previousScene !== p[16] || previousFollow !== followClock.value)) saveSceneSettings()
}

async function syncClock() {
  if (generation.value < 3 || !petState.value.active) return
  if (pendingClock !== undefined) {
    const target = pendingClock
    if (followClock.value !== target) {
      const reply = await win.myApi.petAction(9, Number(target))
      if (reply.state !== 'ready') return
      if (reply.status !== 0 || !hasPetPayload(reply.payload)) {
        interactionNotice.value = '键盘未确认作息设置。'
        if (pendingClock === target) pendingClock = undefined
        saveSceneSettings()
        return
      }
      applyPetReply(reply)
    }
    if (pendingClock === target) pendingClock = undefined
    saveSceneSettings()
  }
  if (!followClock.value || Date.now() < nextClockRetry) return
  const now = new Date()
  if (petState.value.hour === now.getHours() && petState.value.minute === now.getMinutes()) return
  const reply = await win.myApi.petAction(10, now.getHours() * 60 + now.getMinutes())
  if (reply.state === 'ready' && reply.status === 0 && hasPetPayload(reply.payload)) applyPetReply(reply)
  else nextClockRetry = Date.now() + 5000
}

function setFollowClock(checked: boolean) {
  pendingClock = checked
  pendingScene.delete(4)
  nextClockRetry = 0
  if (!petLinked.value) {
    followClock.value = pendingClock
    showOfflineTime()
  }
  saveSceneSettings()
  refreshPetDevice()
}

function showOfflineTime() {
  if (petLinked.value || !followClock.value) return
  const now = new Date()
  petState.value.hour = now.getHours()
  petState.value.minute = now.getMinutes()
}

async function refreshAfterAiStep(session: string) {
  await petTask
  if (appMode.value === 'pet' && session === petSession) refreshPetDevice()
}

function refreshPetDevice() {
  showOfflineTime()
  if (!conState.value && appMode.value === 'pet') previewWorld.start()
  else previewWorld.pause()
  if (petTask || !conState.value || progressShow.value || firmwareUpdating.value ||
      appMode.value === 'pet' && !requestedMode && liveScreens.petRefreshPending()) return
  petTask = (async () => {
    const status = await win.myApi.petAction(0)
    if (status.state === 'busy') return
    if (status.state !== 'ready' || status.status !== 0 || !hasPetPayload(status.payload)) {
      petLinked.value = false
      petSession = undefined
      requestedMode = undefined
      petNotice.value = status.state === 'unsupported' ? '键盘固件需要升级才能同步养宠模式。' : ''
      return
    }
    const intent = requestedMode
    const actualMode = status.payload[0] ? 'pet' : 'work'
    if (intent && intent.session === status.session && actualMode !== intent.mode) {
      const target = intent.mode
      if (target === 'work' && hasPerformanceScreens()) {
        const device = await win.myApi.liveOled()
        if (device.state === 'ready' && device.code === 0 && device.menu > 0 && device.menu <= 10) {
          if (performanceValues.value.length !== 3) await samplePerformance()
          await updatePerformanceColor(device.menu)
        }
        if (requestedMode !== intent) return
      }
      const result = await win.myApi.petAction(1, target === 'pet' ? 1 : 0, intent.session)
      if (requestedMode !== intent) return
      if (result.state !== 'busy') requestedMode = undefined
      if (result.state === 'ready' && result.session === intent.session && result.status === 0 && hasPetPayload(result.payload)) {
        applyPetReply(result)
        if (target === 'pet') await syncClock()
        else refreshDeviceScreens()
      }
      return
    }
    requestedMode = undefined
    applyPetReply(status)
    if (appMode.value !== actualMode) {
      appMode.value = actualMode
      if (actualMode === 'work') refreshDeviceScreens()
      storeMode()
    }
    if (actualMode === 'pet') {
      await syncClock()
      for (const [command, value] of pendingScene) {
        if (command === 6 && legacyPet.value) continue
        const result = await win.myApi.petAction(command, value)
        if (command === 6 && result.state === 'ready' && result.status !== 0 && pendingScene.get(6) === value) {
          if (offlineBackground === value && result.status === 4) break
          pendingScene.delete(6)
          offlineBackground = undefined
          saveSceneSettings()
          interactionNotice.value = result.status === 4 ? '兔子正在互动，请稍后再切换场景。' : '键盘未确认场景切换。'
          continue
        }
        if (result.state !== 'ready' || result.status !== 0 || !hasPetPayload(result.payload)) break
        if (pendingScene.get(command) === value) pendingScene.delete(command)
        applyPetReply(result)
        if (command === 6 && !pendingScene.has(6)) {
          offlineBackground = undefined
          saveSceneSettings()
        }
      }
    }
  })().catch(() => { petLinked.value = false }).finally(() => {
    petTask = undefined
    liveScreens.flushPetRefresh()
  })
}

function saveSceneSettings() {
  const { hour, season, scene } = petState.value
  win.myApi.storageMenu('petSceneSettings', JSON.stringify({ hour, season, scene, offlineBackground, followClock: followClock.value, pendingClock }))
}

function setScene(command: 4 | 5 | 6, value: number) {
  if (command === 4 && followClock.value) return
  interactionNotice.value = ''
  if (command === 6) {
    if (petLinked.value) {
      offlineBackground = undefined
    } else {
      previewWorld.changeScene(value)
      offlineBackground = value
    }
  } else {
    petState.value[command === 4 ? 'hour' : 'season'] = value
    if (command === 4) petState.value.minute = 0
  }
  pendingScene.set(command, value)
  saveSceneSettings()
  refreshPetDevice()
}

async function interactWithPet(command: number, value: number) {
  if (interacting.value || progressShow.value || firmwareUpdating.value) return
  interacting.value = true
  interactionNotice.value = ''
  const stat = petStats.find(entry => entry.command === command)
  const session = petSession
  let applied = false
  await petTask
  const fruitId = command === 2 ? value : command === 12 ? bindings.value?.[value] ?? 0 : 0
  const snack = petFruitIds[fruitId - 1]
  if (stat && session !== petSession) {
    interacting.value = false
    interactionNotice.value = '键盘连接已变化，请重新确认数值。'
    return false
  }
  if (!petLinked.value) {
    if (conState.value) interactionNotice.value = petNotice.value || '等待读取键盘的宠物状态。'
    else if (command === 8) interactionNotice.value = '连接键盘后即可绑定道具。'
    else if (command === 6) previewWorld.changeScene(value)
    else if (snack && offlineWarehouse.value.snacks[fruitId - 1] === 0) interactionNotice.value = petFruitStockMessage(snack)
    else {
      const previewError = previewWorld.use(command, value)
      applied = !previewError
      interactionNotice.value = previewError || (stat ? '已更新本机预览。' : '本机宠物预览')
      if (!previewError && command === 2) {
        offlineWarehouse.value.snacks[value - 1]--
        saveWarehouse()
      }
      if (!previewError && command === 14 && petState.value.hutchPosition) {
        offlineHutch = { ...petState.value.hutchPosition }
        win.myApi.storageMenu('petHutchPreview', JSON.stringify(offlineHutch))
        interactionNotice.value = '已保存预览中的兔窝位置。'
      }
      if (!previewError && command === petLampCommand) {
        offlineLamp = value === 1
        offlineLampLit = petState.value.pendantLampLit
        win.myApi.storageMenu('petPendantLampPreview', JSON.stringify(offlineLamp))
      }
      if (!previewError && command === petToggleLampCommand) offlineLampLit = petState.value.pendantLampLit
    }
    interacting.value = false
    return applied
  }
  petTask = (async () => {
    if (command === 7 && value === 1 && petState.value.scene !== 1) {
      const room = await win.myApi.petAction(6, 1)
      if (room.state !== 'ready' || room.status !== 0 || !hasPetPayload(room.payload) || room.payload[16] !== 1) {
        interactionNotice.value = '键盘未能进入宝宝房，请稍后再试。'
        return
      }
      applyPetReply(room)
    }
    const result = await win.myApi.petAction(command, command === 24 ? invertPetEnergy(value) : value)
    if (result.state === 'ready' && result.status === 0 && hasPetPayload(result.payload)) {
      applyPetReply(result)
      applied = !stat || petState.value.stats?.[stat.id] === value
      if (stat) interactionNotice.value = applied ? '键盘已保存' + stat.label + '。' : '键盘尚未确认该数值。'
      if (command === petLampCommand) {
        applied = petState.value.pendantLamp === (value === 1)
        interactionNotice.value = applied ? (value ? '已安装挂灯。' : '已收起挂灯。') : '键盘尚未确认挂灯设置。'
      }
      if (command === petToggleLampCommand) interactionNotice.value = petState.value.pendantLampLit ? '已开灯。' : '已关灯。'
      if (command === 14) {
        const position = petState.value.hutchPosition
        interactionNotice.value = position && (position.x | (position.y << 9)) === value
          ? '键盘已保存兔窝位置。' : '键盘尚未确认兔窝位置。'
      }
      if (command === 8) {
        const key = value >> 4
        const item = value & 15
        interactionNotice.value = bindings.value?.[key] === item
          ? 'K' + (key + 1) + (item ? ' 已绑定' + petItems.find(entry => entry.itemId === item)?.label : ' 已解除道具绑定')
          : '键盘尚未确认此绑定。'
      }
    } else if (snack && result.state === 'ready' && (result.status === petOutOfStockStatus || result.status === 4)) {
      let outOfStock = result.status === petOutOfStockStatus
      if (!outOfStock && warehouse.value) {
        // Older warehouse firmware used the same status for a full floor and an empty stock.
        const fresh = await win.myApi.petAction(0)
        if (fresh.state === 'ready' && fresh.status === 0 && fresh.session === session && hasPetPayload(fresh.payload)) {
          applyPetReply(fresh)
          outOfStock = warehouse.value?.snacks[fruitId - 1] === 0
        }
      }
      interactionNotice.value = outOfStock ? petFruitStockMessage(snack) : '兔子正在忙，请稍后再试。'
    } else if (stat) interactionNotice.value = '键盘未确认保存，请检查连接后重试。'
    else if (command === 14) interactionNotice.value = '兔窝位置未保存，请检查键盘连接或稍后再试。'
    else interactionNotice.value = result.status === 4 || result.state === 'busy'
      ? '兔子正在忙，请稍后再试。' : '键盘未确认这次操作，请检查连接和当前场景。'
  })().catch(() => { interactionNotice.value = '未能同步宠物操作。' }).finally(() => {
    petTask = undefined
    interacting.value = false
    liveScreens.flushPetRefresh()
  })
  await petTask
  return applied
}

function petContent(index: number) {
  return petParameterContent(petParameterIds.value[index], petState.value)
}

watch(() => JSON.stringify([appMode.value, petLinked.value, petState.value.active, petContent(0), petContent(1)]),
  async (_current, _previous, onCleanup) => {
    if (appMode.value !== 'pet') return
    if (petLinked.value && petState.value.active) liveScreens.refreshPet()
    let stale = false
    onCleanup(() => { stale = true })
    const images = await Promise.all([renderScreenContent(petContent(0)), renderScreenContent(petContent(1))])
    if (!stale) petImages.value = images
  })

function petSettingsSnapshot(): PetSettingsSnapshot | undefined {
  if (!petSettingsView.value) return
  const snapshot: PetSettingsSnapshot = {
    view: petSettingsView.value, state: petState.value, petMode: appMode.value === 'pet', generation: generation.value,
    connected: petLinked.value, session: petSession, legacy: legacyPet.value,
    busy: appMode.value !== 'pet' || interacting.value || progressShow.value || firmwareUpdating.value || conState.value && !petLinked.value,
    followClock: followClock.value, sleeping: isSleeping.value, status: interactionNotice.value || petNotice.value,
    bindings: bindings.value, warehouse: warehouse.value, parameters: petParameterIds.value, previews: petImages.value
  }
  return JSON.parse(JSON.stringify(snapshot))
}

watch(petSettingsSnapshot, snapshot => {
  if (snapshot) win.myApi.updatePetSettings(snapshot)
})

function configurePetScreen(screen: number, key?: number) {
  if (screen !== 0 && screen !== 1 && screen !== 2) return
  interactionNotice.value = ''
  petSettingsView.value = { screen, tab: key === undefined ? 'scene' : 'items',
    selectedItem: key === undefined ? 1 : bindings.value?.[key] || 1, revision: ++petSettingsRevision }
  void win.myApi.openPetSettings(petSettingsSnapshot()).catch(() => {
    petSettingsView.value = undefined
    XBox.popMes('无法打开宠物设置。')
  })
}

function setPetParameter(screen: Exclude<PetSettingsScreen, 0>, row: number, selected: PetParameter) {
  const pair = petParameterIds.value[screen - 1]
  if (pair[1 - row] === selected) pair[1 - row] = pair[row]
  pair[row] = selected
  win.myApi.storageMenu('petScreenParameters', JSON.stringify(petParameterIds.value))
}

async function runPetSettingsCommand(action: PetSettingsAction) {
  if (action[0] === 'clear-notice') { interactionNotice.value = ''; return true }
  if (appMode.value !== 'pet' || !petSettingsView.value) return false
  switch (action[0]) {
    case 'interact': {
      const [, command, value] = action
      if (![3, 6, 8, 11, 15, 23, 24, 25, 26, petLampCommand].includes(command) || !Number.isInteger(value)) return false
      return await interactWithPet(command, value) === true
    }
    case 'scene': {
      const [, command, value] = action
      const max = command === 4 ? 23 : command === 5 ? 3 : command === 6 ? 1 : -1
      if (!Number.isInteger(value) || value < 0 || value > max) return false
      setScene(command, value)
      return true
    }
    case 'follow-clock':
      if (typeof action[1] !== 'boolean') return false
      setFollowClock(action[1])
      return true
    case 'parameter': {
      const [, screen, row, parameter] = action
      if ((screen !== 1 && screen !== 2) || (row !== 0 && row !== 1) ||
          !petParameters.some(entry => entry.id === parameter)) return false
      setPetParameter(screen, row, parameter)
      return true
    }
    case 'move':
      if (!action[2] || typeof action[2] !== 'object') return false
      moveFurniture(action[1], action[2])
      return true
    case 'buy': await buySnack(action[1]); return true
    case 'use': useItem(action[1]); return true
    case 'toggle-lamp': togglePetLamp(); return true
  }
  return false
}

function useItem(id: number) {
  const item = petItems.find(entry => entry.itemId === id)
  if (item) void triggerItem(item)
}

function togglePetLamp() {
  const state = petState.value
  if (!state.pendantLamp) { XBox.popMes('先在装修里安装挂灯。'); return }
  if (petLinked.value && !state.pendantLampManual) { XBox.popMes('请升级键盘固件以手动开关挂灯。'); return }
  void interactWithPet(petToggleLampCommand, 0)
}

function moveFurniture(id: PetFurnitureId, position: PetPosition) {
  const item = petFurniture.find(item => item.id === id)
  if (!item || !furniturePositionValid(item, position.x, position.y) || interacting.value) return
  if (!petLinked.value && !conState.value && id !== 'hutch') {
    offlineFurniture[id] = { ...position }
    if (id === 'table') petState.value.tablePosition = offlineFurniture.table
    else petState.value.lampPosition = offlineFurniture.lamp
    win.myApi.storageMenu('petFurniturePreview', JSON.stringify(offlineFurniture))
    interactionNotice.value = '已保存' + item.label + '位置。'
    return
  }
  void interactWithPet(item.command, position.x | (position.y << 9)).then(ok => {
    if (ok && id !== 'hutch') interactionNotice.value = '已保存' + item.label + '位置。'
  })
}

async function buySnack(id: number) {
  const fruit = petFruitIds[id - 1]
  const stock = warehouse.value
  if (!fruit || !stock || interacting.value || (conState.value && !petLinked.value) ||
      stock.coins < petSnackPrice || stock.snacks[id - 1] > petMaxStock - petSnackPack) return
  if (petLinked.value) {
    if (!await interactWithPet(petBuySnackCommand, id)) return
  } else {
    stock.coins -= petSnackPrice
    stock.snacks[id - 1] += petSnackPack
    saveWarehouse()
  }
  interactionNotice.value = '已将 ' + petSnackPack + ' 份' + petFruitLabels[fruit] + '放入背包。'
}

function triggerItem(item: typeof petItems[number]) {
  if (item.kind === 'fruit') return interactWithPet(2, item.wireId)
  if (item.kind === 'decoration' && (!petLinked.value || generation.value >= 4)) return interactWithPet(15, 0)
  return interactWithPet(7, item.wireId)
}

let keyActions = Promise.resolve()
let pendingRub: { session?: string; value: number; time: number } | undefined
function touchRabbit(gesture: number) {
  if (petLinked.value && generation.value === 5 && gesture > 4) {
    if (gesture < 8) return
    gesture = gesture < 16 ? 3 : 4
  }
  if (petLinked.value && generation.value < 5) {
    interactionNotice.value = '请升级键盘固件以使用摸头动作。'
    return
  }
  // While USB is busy keep only the most recent direction of a continuous rub.
  if (gesture >= 8 && pendingRub && pendingRub.session === petSession) {
    pendingRub.value = gesture
    pendingRub.time = performance.now()
    return
  }
  const request = { session: petSession, value: gesture, time: performance.now() }
  pendingRub = gesture >= 8 ? request : undefined
  keyActions = keyActions.then(async () => {
    if (pendingRub === request) pendingRub = undefined
    if (appMode.value === 'pet' && petSession === request.session && performance.now() - request.time < 1200)
      await interactWithPet(22, request.value)
  }).catch(() => { interactionNotice.value = '未能同步摸头动作。' })
}

function pressHomeKey(key: number) {
  if (appMode.value === 'work') return openConfigWindow(key)
  const item = keyItems.value[key]
  if (!item) return configurePetScreen(0, key)
  const session = petSession
  keyActions = keyActions.then(async () => {
    if (appMode.value !== 'pet' || petSession !== session) return
    if (petLinked.value && generation.value >= 3) await interactWithPet(12, key)
    else await triggerItem(item)
  }).catch(() => { interactionNotice.value = '未能执行宠物按键。' })
}

const test = async () => {
  console.info('test begin')
  let start = await win.myApi.waitSign()
  console.info(start)
  console.info('test end')
}

onMounted(async () => {
  stopPetSettingsClose = win.myApi.onPetSettingsClosed(() => { petSettingsView.value = undefined })
  stopPetSettingsCommand = win.myApi.onPetSettingsCommand((id: number, action: PetSettingsAction) => {
    void runPetSettingsCommand(action).then(
      applied => win.myApi.finishPetSettingsCommand(id, applied),
      () => win.myApi.finishPetSettingsCommand(id, false)
    )
  })
  // 获取解析菜单
  let jsonStr = await win.myApi.getMenu('configData')
  if(jsonStr != '' && jsonStr != undefined && jsonStr != null)
    parseMenuConfig(jsonStr)
  await restoreDisplayMode()
  try {
    const savedParameters = JSON.parse(await win.myApi.getMenu('petScreenParameters') || 'null')
    const valid = (id: unknown): id is PetParameter => petParameters.some(option => option.id === id)
    if (Array.isArray(savedParameters) && savedParameters.length === 2) {
      savedParameters.forEach((stored, screen) => {
        const fallback = petParameterIds.value[screen]
        const migrate = (id: unknown) => id === 'sleepiness' ? 'energy' : id
        const first = migrate(Array.isArray(stored) ? stored[0] : stored)
        if (!valid(first)) return
        const second = migrate(Array.isArray(stored) ? stored[1] : undefined)
        petParameterIds.value[screen] = [first, valid(second) && second !== first ? second : fallback.find(id => id !== first)!]
      })
    }
  } catch { /* Fall back to the default OLED parameters. */ }
  try {
    const savedKeys: unknown = JSON.parse(await win.myApi.getMenu('petKeyPreview') || 'null')
    if (Array.isArray(savedKeys) && savedKeys.length === 8 && savedKeys.every(id => id === 0 ||
        petItems.some(item => item.itemId === id))) previewKeys.value = savedKeys as number[]
  } catch { /* Offline previews start with the eight fruit keys. */ }
  try {
    const saved = JSON.parse(await win.myApi.getMenu('petHutchPreview') || 'null')
    if (saved && isHutchPosition(saved.x, saved.y)) {
      offlineHutch = { x: saved.x, y: saved.y }
      if (!petLinked.value) petState.value.hutchPosition = { ...offlineHutch }
    }
  } catch { /* Use the default layout for a new local preview. */ }
  offlineLamp = await win.myApi.getMenu('petPendantLampPreview').catch(() => undefined) === 'true'
  offlineLampLit = undefined
  if (!petLinked.value) petState.value.pendantLamp = offlineLamp
  try {
    const saved = JSON.parse(await win.myApi.getMenu('petWarehousePreview') || 'null')
    if (saved && Number.isInteger(saved.coins) && saved.coins >= 0 && saved.coins <= petMaxCoins &&
        Array.isArray(saved.snacks) && saved.snacks.length === petFruitIds.length &&
        saved.snacks.every((n: number) => Number.isInteger(n) && n >= 0 && n <= petMaxStock)) {
      const owned = Number.isInteger(saved.owned) && saved.owned >= 0 && saved.owned <= petStarterItems ? saved.owned : petStarterItems
      offlineWarehouse.value = { coins: saved.coins, snacks: saved.snacks, owned }
    }
  } catch { /* Retain starter inventory. */ }
  try {
    const saved = JSON.parse(await win.myApi.getMenu('petFurniturePreview') || 'null')
    for (const item of [petFurniture[1], petFurniture[2]]) {
      const point = saved?.[item.id]
      if (point && furniturePositionValid(item, point.x, point.y)) offlineFurniture[item.id] = { x: point.x, y: point.y }
    }
    if (!petLinked.value) {
      petState.value.tablePosition = offlineFurniture.table
      petState.value.lampPosition = offlineFurniture.lamp
    }
  } catch { /* Retain the starter layout. */ }
  try {
    const savedScene = JSON.parse(await win.myApi.getMenu('petSceneSettings') || 'null')
    followClock.value = savedScene?.followClock === true
    pendingClock = typeof savedScene?.pendingClock === 'boolean' ? savedScene.pendingClock : undefined
    if (Number.isInteger(savedScene?.hour) && savedScene.hour >= 0 && savedScene.hour < 24 &&
        Number.isInteger(savedScene?.season) && savedScene.season >= 0 && savedScene.season < 4) {
      petState.value = { ...petState.value, hour: savedScene.hour, season: savedScene.season }
      if (!followClock.value && pendingClock !== true) pendingScene.set(4, savedScene.hour)
      pendingScene.set(5, savedScene.season)
    }
    if (Number.isInteger(savedScene?.scene) && petScenes[savedScene.scene]) {
      petState.value.scene = savedScene.scene
    }
    if (Number.isInteger(savedScene?.offlineBackground) && petScenes[savedScene.offlineBackground]) {
      offlineBackground = savedScene.offlineBackground as number
      pendingScene.set(6, offlineBackground)
    }
  } catch { /* Use the device scene or the default preview. */ }
  try {
    const saved = JSON.parse(await win.myApi.getMenu('pendingWorkLayers') || '[]')
    if (Array.isArray(saved)) pendingWorkLayers.value = [...new Set(saved.filter(index => Number.isInteger(index) && index >= 0 && index < 10))]
  } catch { /* A missing queue starts empty. */ }
  workSyncReady = true
  // 连接硬件
  conState.value = await testConnection()
  scheduleWorkSync()
  refreshDeviceScreens()
  screenPoll = setInterval(refreshDeviceScreens, 1800)
  buttonPoll = setInterval(refreshDeviceButtons, 45)
  liveScreens.tick()
  liveTimer = setInterval(() => {
    if (hasPerformanceScreens()) void samplePerformance()
    if (workSyncTimer === undefined && pendingWorkLayers.value.length) void syncWorkConfig()
    else liveScreens.tick()
  }, 1500)
  if (hasPerformanceScreens()) void samplePerformance()
  refreshPetDevice()
  petTimer = setInterval(refreshPetDevice, 700)
  let lastPetMotionPoll = 0
  petMotionTimer = setInterval(() => {
    if (!petLinked.value || !petState.value.active) return
    const now = Date.now()
    if (petState.value.action !== 6 && now - lastPetMotionPoll < 240) return
    lastPetMotionPoll = now
    refreshPetDevice()
  }, 120)
  window.addEventListener('focus', refreshPetDevice)
  // 主页面监听
  win.myApi.storeChangeListen((objData) => {
    // console.info('homePage listening', objData)
    // 有 get 属性
    if (objData.get) {
      let storeValue = objData.get
      let tempObj = {}
      tempObj[storeValue] = configStore[storeValue]
      if (typeof configStore[storeValue] == 'object') {
        tempObj[storeValue] = JSON.stringify(configStore[storeValue])
      }
      // 发送其他窗口同步
      win.myApi.setConfigStore(tempObj)
      return
    }
    try {
      if (objData.screenPerformance) {
        const { menu, enabled } = objData.screenPerformance as { menu: number; enabled: boolean }
        const existing = configStore.menuConfig[menu]?.screenConfig[0]
        const { baseData = '', buffData = [] } = existing ?? {}
        saveWorkScreen(menu, 0, { baseData, buffData, content: enabled ? { mode: 'performance' } : undefined })
        return
      }
      if (objData.screenFrame) {
        const { menu, screen, frame } = objData.screenFrame as { menu: number; screen: number; frame: ScreenFrame }
        const current = configStore.menuConfig[menu]?.screenConfig[screen]
        saveWorkScreen(menu, screen, screen === 0 && current?.content?.mode === 'performance'
          ? { ...frame, content: current.content } : frame)
        return
      }
      // 同步信息
      const keys = Object.keys(objData)
      for (let key of keys) {
        // 设置对应 store 的值
        configStore[`set${key.replace(key.charAt(0), key.charAt(0).toUpperCase())}`](objData[key])
      }
      if ('screenData' in objData) {
        storageCurMenu()
        closeStorage()
      }
    } catch (error) {
      console.error(error)
      XBox.popMes('同步信息错误')
    }
  })
  // 右键菜单
  win.oncontextmenu = function (e) {
    e.preventDefault()
    // console.info(e)
    let topData = e.clientY
    let leftData = e.clientX
    if (topData > 250) topData = 250
    if (leftData > 450) leftData = 450
    menuStore.setPosition(topData, leftData)
    menuStore.setMenuShow(true)
    // console.info(menuStore.menuShow)
  }
  window.onclick = function (e) {
    // console.info(e)
    menuStore.setPosition('', '')
    menuStore.setMenuShow(false)
  }
})

onUnmounted(() => {
  stopPetSettingsCommand?.()
  stopPetSettingsClose?.()
  window.removeEventListener('focus', refreshPetDevice)
  clearInterval(liveTimer)
  liveScreens.cancelPetRefresh()
  clearTimeout(workSyncTimer)
  workSyncReady = false
  clearInterval(petTimer)
  clearInterval(petMotionTimer)
  previewWorld.reset()
  clearInterval(screenPoll)
  clearInterval(buttonPoll)
  clearButtonHighlights()
})

// 打开键值编辑窗口
const openConfigWindow = async (index: number) => {
  configStore.setConfigIndex(index)
  // 重置单键配置
  for (let i = 0; i < 6; i++) {
    configStore.setCurEvent(i)
    let temp = {
      userKey: '',
      genKey: ''
    }
    configStore.setKeyConfig(JSON.stringify(temp))
  }
  if (configStore.layerKeyConfig[index].length != 0) {
    for (let i = 0; i < 6; i++) {
      configStore.setCurEvent(i)
      let temp = {
        userKey: configStore.layerKeyConfig[index][i].userKey,
        genKey: configStore.layerKeyConfig[index][i].genKey
      }
      configStore.setKeyConfig(JSON.stringify(temp))
    }
  }
  // console.info(configStore.keyConfig)
  createWindow('/config')
  // await new Promise(resolve => setTimeout(resolve, 1000));
}

const createWindow = (route: string, windowOptions = {}) => {
  // console.log(router)
  // console.log(router.currentRoute.value.path)
  win.myApi.createNewWindow(
    {
      route: route
    },
    {
      width: 900,
      height: 700,
      minWidth: 800,
      minHeight: 630,
      ...windowOptions
    }
  )
}

// 连接状态
const conState = ref<boolean>(false)
// 手动重新连接
const titleClick = async () => {
  buttonSyncUnsupported = false
  requestedMode = undefined
  petSession = undefined
  conState.value = await testConnection()
  liveScreens.forgetDevice()
  liveScreens.tick()
  refreshDeviceScreens()
  refreshPetDevice()
  nextWorkAttempt = 0
  scheduleWorkSync()
}


// 同步一层配置的功能
watch(
  () => configStore.keyConfig,
  () => {
    configStore.setLayerKeyConfig(JSON.stringify(configStore.keyConfig))
    storageCurMenu()
  },
  {
    deep: true
  }
)

// 数据上传页面显示
const progressShow = ref<boolean>(false)
const firmwareUpdating = ref(false)
const hasPerformanceScreens = () => configStore.menuConfig.some(menu => menu.screenConfig[0]?.content?.mode === 'performance')
const hasDynamicScreens = () => appMode.value === 'pet' || configStore.menuConfig.some(menu => menu.screenConfig.some((screen: ScreenFrame) =>
  screen?.content && screen.content.mode !== 'text'))
let previewRequest = 0
async function refreshPerformancePreview(menu: number) {
  const request = ++previewRequest
  const values = await win.myApi.pcPerformancePreview(menu + 1).catch(() => [])
  if (request === previewRequest) performancePreview.value = { menu, values }
}
const samplePerformance = async () => {
  performanceValues.value = await win.myApi.pcPerformance().catch(() => [])
  await refreshPerformancePreview(configStore.curMenu)
}
let performanceMenu = 0
async function updatePerformanceColor(deviceMenu: number) {
  const menu = deviceMenu - 1
  const enabled = configStore.menuConfig[menu]?.screenConfig[0]?.content?.mode === 'performance'
  if (enabled && performanceValues.value.length !== 3) return
  if (!enabled && !performanceMenu) return
  const result = await win.myApi.livePerformance(enabled ? deviceMenu : 0,
    enabled ? [...performanceValues.value] : undefined)
  if (result === 'ready' || result === 'unsupported') performanceUnavailable.value = result === 'unsupported'
  if (result === 'ready') {
    performanceMenu = enabled ? deviceMenu : 0
    if (configStore.curMenu === menu) await refreshPerformancePreview(menu)
  }
}
const liveScreens = createLiveScreens(menu => appMode.value === 'work' || !petState.value.active
  ? configStore.menuConfig[menu]?.screenConfig
  : [{ baseData: '', buffData: [] }, ...[0, 1].map(index => ({ baseData: '', buffData: [], content: petContent(index) }))],
  () => progressShow.value || firmwareUpdating.value || Boolean(petTask), hasDynamicScreens,
  connected => {
    conState.value = connected
    if (!connected) {
      requestedMode = undefined
      petLinked.value = false
      petSession = undefined
    }
  },
  updatePerformanceColor, () => appMode.value === 'pet' && petState.value.active)
const updateFirmware = async () => {
  if (firmwareUpdating.value || progressShow.value) return
  firmwareUpdating.value = true
  try {
    await Promise.all([screenReadTask, buttonReadTask, petTask, liveScreens.wait()])
    clearButtonHighlights()
    const result = await win.myApi.updateFirmware()
    if (result.state === 'cancelled') return
    buttonSyncUnsupported = false
    deviceScreens.value = undefined
    conState.value = await win.myApi.connectHardware()
    liveScreens.forgetDevice()
    XBox.popMes(result.state === 'updated' ? '固件升级完成' : result.message)
  } catch (error) {
    console.error(error)
    XBox.popMes('USB 固件升级失败')
  } finally {
    firmwareUpdating.value = false
    liveScreens.tick()
    refreshDeviceScreens()
  }
}
const pendingWorkLayers = ref<number[]>([])
const workSyncFailed = ref(false)
let workSyncReady = false
let workSyncTimer: ReturnType<typeof setTimeout> | undefined
let nextWorkAttempt = 0

function savePendingWorkLayers() {
  win.myApi.storageMenu('pendingWorkLayers', JSON.stringify(pendingWorkLayers.value))
}

function scheduleWorkSync() {
  if (!workSyncReady || !pendingWorkLayers.value.length) return
  clearTimeout(workSyncTimer)
  workSyncTimer = setTimeout(() => {
    workSyncTimer = undefined
    void syncWorkConfig()
  }, 400)
}

const workLayerSignature = (layer: WorkLayer) => JSON.stringify(workLayerPayload(layer))
watch(() => JSON.stringify(configStore.menuConfig), (current, previous) => {
  if (!workSyncReady) return
  win.myApi.storageMenu('configData', current)
  const before: WorkLayer[] = JSON.parse(previous)
  const after: WorkLayer[] = JSON.parse(current)
  const changed = after.flatMap((layer, index) => workLayerSignature(layer) !== workLayerSignature(before[index]) ? [index] : [])
  if (!changed.length) return
  pendingWorkLayers.value = [...new Set([...pendingWorkLayers.value, ...changed])]
  savePendingWorkLayers()
  workSyncFailed.value = false
  nextWorkAttempt = 0
  scheduleWorkSync()
})
watch(appMode, mode => { if (mode === 'work') scheduleWorkSync() })

async function syncWorkConfig() {
  if (!workSyncReady || progressShow.value || firmwareUpdating.value || !pendingWorkLayers.value.length ||
    appMode.value !== 'work' || petState.value.active || Date.now() < nextWorkAttempt) {
    liveScreens.tick()
    return
  }
  const layers: WorkLayer[] = JSON.parse(JSON.stringify(configStore.menuConfig))
  const changed = [...pendingWorkLayers.value]
  progressShow.value = true
  let ownsTransfer = false
  try {
    await Promise.all([screenReadTask, buttonReadTask, petTask, liveScreens.wait()])
    conState.value = await win.myApi.connectHardware()
    if (!conState.value) {
      nextWorkAttempt = Date.now() + 5000
      return
    }
    const mode = await win.myApi.petAction(0)
    if (mode.state === 'ready' && mode.status === 0 && hasPetPayload(mode.payload) && mode.payload[0]) {
      applyPetReply(mode)
      return
    }
    if (mode.state === 'busy' || mode.state === 'disconnected') return
    await win.myApi.setDeviceConfiguring(true)
    ownsTransfer = true
    const previous = await win.myApi.readWorkLayout()
    if (previous.state !== 'ready' && previous.state !== 'unsupported') throw Error('未能读取键盘配置层')
    const expected = await sendWorkConfiguration(layers, changed, previous.state === 'ready' ? previous : undefined,
      bytes => win.myApi.sendData(bytes))
    if (previous.state === 'ready') {
      const confirmed = await win.myApi.readWorkLayout()
      if (confirmed.state !== 'ready' || expected.some((value, index) => value !== confirmed.bytes[index]))
        throw Error('键盘未确认配置层')
    }
    pendingWorkLayers.value = pendingWorkLayers.value.filter(index => !changed.includes(index) ||
      workLayerSignature(layers[index]) !== workLayerSignature(configStore.menuConfig[index]))
    savePendingWorkLayers()
    workSyncFailed.value = false
    deviceScreens.value = undefined
  } catch (error) {
    console.error(error)
    workSyncFailed.value = true
    nextWorkAttempt = Date.now() + 5000
  } finally {
    if (ownsTransfer) await win.myApi.setDeviceConfiguring(false).catch(() => {})
    progressShow.value = false
    liveScreens.tick()
    refreshDeviceScreens()
  }
}

// 切换菜单
const setMenu = (index: number) => {
  resetData()
  configStore.setCurMenu(index)
  loadMenu()
}

// 菜单切换
const screenLabels = ['彩屏', '左侧 OLED', '右侧 OLED']
const keyOrder = [0, 2, 4, 6, 1, 3, 5, 7]

const menuIndex = computed(() => configStore.curMenu + 1)
const menuChange = (func: number) => {
  storageCurMenu()
  setMenu((configStore.curMenu + (func ? 1 : 9)) % 10)
}

// 存储当前菜单配置
const storageCurMenu = () => {
  let tempObj = {
    keyConfig: configStore.layerKeyConfig,
    screenConfig: configStore.screenData
  }
  // 存储在全层数据
  configStore.setMenuConfig(JSON.stringify(tempObj))
  
}

function saveWorkScreen(menu: number, screen: number, frame: ScreenFrame) {
  if (!Number.isInteger(menu) || menu < 0 || menu >= 10 ||
    !Number.isInteger(screen) || screen < 0 || screen >= 3) return
  if (menu === configStore.curMenu) {
    configStore.screenData[screen] = frame
    storageCurMenu()
  } else {
    const saved = configStore.menuConfig[menu]
    const screenConfig = [0, 1, 2].map(index => index === screen ? frame :
      saved.screenConfig[index] ?? { baseData: '', buffData: [] })
    configStore.menuConfig[menu] = { ...saved, screenConfig }
  }
  closeStorage()
  if (screen === 0 && frame.content?.mode === 'performance') void samplePerformance().then(() => liveScreens.tick())
  else liveScreens.tick()
}

const showingPerformance = computed(() => configStore.screenData[0].content?.mode === 'performance')

function openPerformancePage() {
  storageCurMenu()
  closeStorage()
  createWindow(`/performance?menu=${configStore.curMenu}`, { width: 510, height: 404, minWidth: 460, minHeight: 390 })
}

// 显示屏幕编辑
const openScreenPage = (curScreen: number) => {
  if (appMode.value === 'pet') return configurePetScreen(curScreen)
  storageCurMenu()
  closeStorage()
  createWindow(`/screen?screen=${curScreen}&menu=${configStore.curMenu}`)
}

const deviceScreens = shallowRef<{ generation: number; menu: number; images: string[] }>()
let screenPoll: ReturnType<typeof setInterval> | undefined
let screenReadTask: Promise<void> | undefined

async function readDeviceScreens() {
  try {
    const result: DeviceScreens = await win.myApi.readDeviceScreens(deviceScreens.value?.generation)
    if (result.state === 'busy') return
    if (result.state === 'ready') {
      deviceScreens.value = {
        generation: result.generation,
        menu: result.menu,
        images: renderDeviceScreens(result.pixels)
      }
    } else if (result.state !== 'unchanged') {
      deviceScreens.value = undefined
      if (result.state === 'disconnected') conState.value = false
    }
  } catch (error) {
    console.error(error)
    deviceScreens.value = undefined
  }
}

function refreshDeviceScreens() {
  if (!conState.value || appMode.value === 'pet' || petState.value.active || progressShow.value || firmwareUpdating.value || screenReadTask) return
  screenReadTask = readDeviceScreens().finally(() => { screenReadTask = undefined })
}

const screenPreviews = computed(() => {
  if (conState.value && deviceScreens.value?.menu === configStore.curMenu + 1 &&
    !pendingWorkLayers.value.includes(configStore.curMenu)) return deviceScreens.value.images
  return configStore.screenData.map((saved, screen) => {
    const baseData = liveScreens.current(configStore.curMenu, screen, saved)?.frame?.baseData ?? saved.baseData
    return baseData ? `data:image/png;base64,${baseData}` : ''
  })
})

const heldButtons = ref(0)
const pulsingButtons = ref(0)
const pulseTimers = new Map<number, ReturnType<typeof setTimeout>>()
let buttonPoll: ReturnType<typeof setInterval>
let buttonReadTask: Promise<void> | undefined
let buttonSyncUnsupported = false

function clearButtonHighlights() {
  heldButtons.value = 0
  pulsingButtons.value = 0
  for (const timer of pulseTimers.values()) clearTimeout(timer)
  pulseTimers.clear()
}

async function readDeviceButtons() {
  const result: DeviceButtons = await win.myApi.readDeviceButtons()
  if (result.state === 'busy') return
  if (result.state !== 'ready') {
    clearButtonHighlights()
    buttonSyncUnsupported = result.state === 'unsupported'
    if (result.state === 'disconnected') {
      conState.value = false
      deviceScreens.value = undefined
    }
    return
  }

  const knobMask = 1 << 10
  const knobWasHeld = Boolean(heldButtons.value & knobMask)
  const smallKnob2 = 1 << 9
  const smallKnobReleased = ((heldButtons.value | result.pressed) & smallKnob2) && !(result.held & smallKnob2)
  heldButtons.value = result.held
  if (generation.value >= 6 && appMode.value === 'pet' &&
      (knobWasHeld || (result.held & knobMask) || (result.pressed & (knobMask | 0xff)) || smallKnobReleased)) refreshPetDevice()
  for (let index = 0; index < 11; index++) {
    const bit = 1 << index
    if (!(result.pressed & bit)) continue
    clearTimeout(pulseTimers.get(index))
    pulsingButtons.value |= bit
    // Keep taps visible even when the key is released between two USB reads.
    pulseTimers.set(index, setTimeout(() => {
      pulsingButtons.value &= ~bit
      pulseTimers.delete(index)
    }, 125))
  }
}

function refreshDeviceButtons() {
  if (!conState.value || buttonSyncUnsupported || progressShow.value || firmwareUpdating.value || petTask || buttonReadTask || liveScreens.petRefreshPending()) return
  buttonReadTask = readDeviceButtons().catch(clearButtonHighlights).finally(() => { buttonReadTask = undefined })
}

function isDeviceButtonActive(index: number) {
  return Boolean((heldButtons.value | pulsingButtons.value) & (1 << index))
}
const closeStorage = () => {
  // 存储全层菜单
  win.myApi.storageMenu('configData', JSON.stringify(configStore.menuConfig))
}

// 软件信息
const infoShow = ref<boolean>(false)
const showAppInfo = () => {
  infoShow.value = true
}

</script>

<template>
  <div id="app-info" v-if="infoShow" @click.stop="infoShow = false">
    <AppInfo @click.stop="" />
  </div>
  <ContextMenu />
  <PopBox ref="popBoxRef" />
  <div class="container multipad-home">
    <WindowTitle fixed-size @before-close="closeStorage">
      <template #title>
        <div class="home-toolbar">
          <button class="app-name" type="button" title="关于 MultiPad" @click="showAppInfo">MultiPad</button>
          <button class="connection-state" :class="{ connected: conState }" type="button"
            title="重新连接键盘" @click="titleClick">
            {{ conState ? '已连接' : '未连接' }}
          </button>
          <button class="firmware-update" type="button" :disabled="firmwareUpdating || progressShow"
            title="通过 USB 升级键盘固件" @click="updateFirmware">
            {{ firmwareUpdating ? '升级中' : 'USB 升级' }}
          </button>
          <div class="mode-switch" role="group" aria-label="显示模式">
            <button type="button" :aria-pressed="appMode === 'work'" :disabled="progressShow || firmwareUpdating" @click="setAppMode('work')">工作模式</button>
            <button type="button" :aria-pressed="appMode === 'pet'" :disabled="progressShow || firmwareUpdating" @click="setAppMode('pet')">养宠模式</button>
          </div>
          <span v-if="appMode === 'work' && pendingWorkLayers.length" class="work-sync-status" role="status">
            {{ progressShow ? '正在同步' : workSyncFailed ? '同步中断，正在重试' : conState ? '等待同步' : '连接后自动同步' }}
          </span>
          <span v-else-if="appMode === 'work' && performanceUnavailable && showingPerformance"
            class="work-sync-status" role="status">性能监测需升级固件</span>
        </div>
      </template>
    </WindowTitle>
    <div id="home-content">
      <div class="rotary-pair">
        <button class="rotary" :class="{ 'device-active': isDeviceButtonActive(8) }"
          type="button" :title="appMode === 'pet' ? '宠物时间设置' : '配置旋钮 1'" @click.stop="appMode === 'pet' ? configurePetScreen(0) : openConfigWindow(8)">旋钮 1</button>
        <button class="rotary" :class="{ 'device-active': isDeviceButtonActive(9) }"
          type="button" :title="appMode === 'pet' ? '手动开关挂灯' : '配置旋钮 2'" @click.stop="appMode === 'pet' ? togglePetLamp() : openConfigWindow(9)">旋钮 2</button>
      </div>
      <div class="screen-panel">
        <button v-for="(label, index) in screenLabels" :key="label" class="screen-card" type="button"
          :title="appMode === 'pet' ? (index ? `设置${label}宠物参数` : '打开宠物设置') : (!index && showingPerformance ? '打开电脑性能监测' : `编辑${label}内容`)"
          @click="appMode === 'work' && !index && showingPerformance ? openPerformancePage() : openScreenPage(index)">
          <span class="screen-image">
            <PetDisplay v-if="appMode === 'pet' && index === 0" :state="petState" :connected="petLinked && petState.active" />
            <img v-else-if="appMode === 'pet' && index && petImages[index - 1]" :src="petImages[index - 1]" alt="" />
            <PerformanceDisplay v-else-if="appMode === 'work' && index === 0 && showingPerformance"
              :values="performancePreview?.menu === configStore.curMenu ? performancePreview.values : performanceValues" />
            <img v-else-if="appMode === 'work' && screenPreviews[index]" :src="screenPreviews[index]" alt="" />
          </span>
          <span>{{ appMode === 'pet' ? (index ? petContent(index - 1).rows.map(row => row.label).join(' · ') : '宠物设置') : (index ? label : showingPerformance ? '彩屏 · 性能监测' : '彩屏 · 图片') }}</span>
        </button>
        <PetAiActivity @step-accepted="refreshAfterAiStep" v-if="appMode === 'pet'" :session="petLinked && petState.active ? petSession : undefined" />
        <div v-if="appMode === 'pet'" class="mode-status" role="status">
          {{ petNotice || interactionNotice || (petLinked && petState.active ? '键盘养宠模式已同步' : '本机宠物预览') }}
        </div>
        <div v-else class="layer-actions">
          <div class="display-entry-points" role="group" aria-label="彩屏设置">
            <button type="button" @click="openScreenPage(0)">编辑图片</button>
            <button type="button" :class="{ selected: showingPerformance }" @click="openPerformancePage">性能监测</button>
          </div>
          <div id="menu-box" role="group" aria-label="本机配置层">
            <button class="layer-arrow" type="button" title="上一层" aria-label="上一层"
              @click="menuChange(0)"></button>
            <span aria-live="polite">本机第 {{ menuIndex }} 层</span>
            <button class="layer-arrow next" type="button" title="下一层" aria-label="下一层"
              @click="menuChange(1)"></button>
          </div>
        </div>
      </div>
      <div class="key-panel">
        <button v-for="index in keyOrder" :key="index" class="key-button" type="button"
          :class="{ 'device-active': isDeviceButtonActive(index) }"
          :title="appMode === 'pet' ? `K${index + 1} · ${keyItems[index]?.label ?? '未绑定，点击设置'}` : `配置 K${index + 1}`"
          @click.stop="pressHomeKey(index)">
          <span v-if="appMode === 'pet' && keyItems[index]" class="key-item-icon" aria-hidden="true"
            :style="{ backgroundPositionX: (1 - keyItems[index]!.itemId) * 16 + 'px' }"></span>
          <span>K{{ index + 1 }}</span><small v-if="appMode === 'pet' && !keyItems[index]">未绑定</small>
        </button>
      </div>
      <PetHeadKnob v-if="appMode === 'pet'" :class="{ 'device-active': isDeviceButtonActive(10) }"
        @pat="touchRabbit" @switch-mode="setAppMode('work')" />
      <button v-else class="rotary rotary-large" type="button" title="配置旋钮 3"
        :class="{ 'device-active': isDeviceButtonActive(10) }"
        @click.stop="openConfigWindow(10)">旋钮 3</button>
    </div>

  </div>
</template>

<style lang="scss" scoped>
.mode-switch { -webkit-app-region: no-drag; display: inline-flex; gap: 2px; padding: 2px; background: #dce5e8; border-radius: 8px; }
.home-toolbar .mode-switch button { padding: 5px 7px; border: 0; border-radius: 6px; font-size: 13px; white-space: nowrap; color: #263d46; background: transparent; cursor: pointer; }
.home-toolbar .mode-switch button[aria-pressed="true"] { color: white; background: #263d46; }
.mode-status { grid-column: 1 / -1; align-self: center; font-size: 12px; color: #405058; }
#app-info {
  @include global.full_wh;
  @include global.pos_ab;
  z-index: 88;
}

.multipad-home {
  width: 95%;
  height: 100%;
  @include global.pos_ab(50%, 50%, 0);
  transform: translate(-52%, -50%);
  border: 10px solid #0f1017;
  border-radius: 4em;
  box-sizing: border-box;
  padding: 10px 10px 12px;
  z-index: 2;
  color: #17272d;
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  background: #e5eae9 linear-gradient(20deg, #e5eae9 0%, #8f9d9f 100%);
}

.home-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  white-space: nowrap;
}

.home-toolbar button, #home-content button {
  font: inherit;
  border: 0;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid #fff;
    box-shadow: 0 0 0 4px #164d64;
  }

  &:disabled {
    cursor: default;
  }
}

.home-toolbar button {
  flex: none;
  font-size: 13px;
  -webkit-app-region: no-drag;
}

.home-toolbar .app-name {
  padding: 3px 0;
  border-radius: 4px;
  background: transparent;
  color: #15272d;
  font-size: 19px;
  font-weight: 700;
}

.connection-state, .firmware-update {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  background: #edf1f0;
  color: #233a42;
}

.home-toolbar .connection-state,
.home-toolbar .firmware-update {
  -webkit-app-region: no-drag;
}

.connection-state {
  gap: 6px;

  &::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #607078;
  }

  &.connected::before {
    background: #247351;
  }
}

.firmware-update {
  background: #dbe3e4;
}

#home-content {
  @include global.wh(100%, 400px);
  @include global.grid_config(repeat(7, 1fr), repeat(5, 1fr));
  overflow: hidden;

  button {
    min-width: 0;
  }
}

.rotary-pair {
  grid-area: 1 / 1 / 3 / 2;
  @include global.flex_config(1, space-around);
  align-items: center;

  .rotary {
    width: 72px;
    height: 72px;
  }
}

#home-content .rotary {
  border-radius: 50%;
  background: #18232b;
  color: #e4edea;
  font-size: 13px;
  font-weight: 600;

  &:hover {
    background: #2b404b;
  }
}

.screen-panel {
  grid-area: 1 / 2 / 3 / 8;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
  padding-left: 10px;
}

#home-content .screen-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 10px;
  background: #e9efed;
  color: #314750;
  font-size: 12px;
  font-weight: 600;

  &:hover {
    background: #f6f9f8;
  }
}

.screen-card:nth-child(1) { grid-area: 1 / 1 / 4 / 4; }
.screen-card:nth-child(2) { grid-area: 1 / 4 / 3 / 6; }
.screen-card:nth-child(3) { grid-area: 1 / 6 / 3 / 8; }

.screen-image {
  display: block;
  width: min(100%, 120px);
  aspect-ratio: 72 / 40;
  overflow: hidden;
  border-radius: 4px;
  background: #17242b;

  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
  }
}

.screen-card:first-child .screen-image {
  width: min(100%, 200px);
  aspect-ratio: 320 / 172;
}

.layer-actions {
  grid-area: 3 / 4 / 4 / 8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.display-entry-points {
  display: flex;
  gap: 4px;
}
#home-content .display-entry-points button {
  padding: 6px;
  border-radius: 6px;
  background: #e9efed;
  color: #273d45;
  font-size: 11px;
  white-space: nowrap;
}
#home-content .display-entry-points button:hover { background: #f6f9f8; }
#home-content .display-entry-points button.selected { background: #214c49; color: #f0fcf8; }
.work-sync-status { color: #324a54; font-size: 11px; font-weight: 500; }

#menu-box {
  display: flex;
  align-items: center;
  min-height: 36px;
  border-radius: 8px;
  padding: 2px;
  background: #e9efed;
  color: #273d45;
  font-size: 13px;
  white-space: nowrap;

  span {
    min-width: 6.5em;
    text-align: center;
  }
}

#home-content .layer-arrow {
  display: grid;
  width: 26px;
  height: 30px;
  place-items: center;
  border-radius: 6px;
  background: transparent;
  color: #273d45;

  &:hover { background: #d4e1de; }

  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border: solid currentColor;
    border-width: 0 2px 2px 0;
    transform: rotate(135deg);
  }

  &.next::before { transform: rotate(-45deg); }
}

.key-panel {
  grid-area: 3 / 1 / 6 / 6;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 15px;
  height: 210px;
  margin-top: 15px;
  border-radius: 12px;
  background: linear-gradient(62deg, #cfaaac 0%, #a9b7c0 100%);
}

#home-content .key-button {
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:3px;
  border-radius: 12px;
  background: #3d454f;
  color: #f4f6f7;
  font-size: 17px;
  font-weight: 600;

  &:hover { background: #4c5965; }
  .key-item-icon { display:block; width:16px; height:16px; background:url('../assets/pet/items.png') no-repeat;
    transform:scale(2.5); margin:10px 5px 9px; image-rendering:pixelated; }
  small { color:#c7d2d0; font-size:10px; }
}

#home-content .rotary-large {
  grid-area: 3 / 6 / 6 / 8;
  width: 210px;
  height: 210px;
  position: fixed;
  right: -40px;
  bottom: 20px;
  padding-right: 32px;

  &:focus-visible {
    outline-offset: -5px;
  }
}

#home-content button.device-active,
#home-content button.device-active:hover {
  background: #236250;
  color: #fff;
  outline: 3px solid #bcebd2;
  outline-offset: -5px;
}
</style>
