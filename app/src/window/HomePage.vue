<script setup lang="ts">
import WindowTitle from '../components/tools/WindowTitle.vue'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import PopBox from '../components/tools/PopBox.vue'
import ProgressBox from '../components/homePage/ProgressBox.vue'
import AppInfo from '../components/homePage/AppInfo.vue'
import ContextMenu from '../views/contextMenu.vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '../stores/configStore'
import { useMenuStore } from '../stores/menuStore'
import { parseMenuConfig, testConnection, sendMenu, sendColorScreen, sendOledScreen, sendConfigData, loadMenu, resetData } from '../utils/dataHandle'
// import { setItem, getItem } from '@/utils/storage'
import { XBox } from 'ilx1-x-box'
import { renderDeviceScreens, type DeviceScreens } from '../utils/deviceScreenFormat'
import type { DeviceButtons } from '../utils/deviceButtonState'
import { createLiveScreens } from '../components/screenPage/liveScreens'
import { renderScreenContent, type ScreenFrame } from '../components/screenPage/screenContent'
import PetDisplay from '../components/screenPage/PetDisplay.vue'
import PetAiSettings from '../components/screenPage/PetAiSettings.vue'
import PerformanceDisplay from '../components/screenPage/PerformanceDisplay.vue'
import { petParameters, petValue, petFruits, petSeasons, petStats, type PetParameter, type PetState } from '../components/screenPage/petDisplay'
import { petActions, petActionLabels, petScenes, petSceneLabels, petToys } from '../utils/petCatalog'

const router = useRouter()
const win = window as any
const configStore = useConfigStore()
const menuStore = useMenuStore()
const popBoxRef = ref<HTMLElement | null>(null)
let liveTimer: ReturnType<typeof setInterval> | undefined
let petTimer: ReturnType<typeof setInterval> | undefined
let petTask: Promise<void> | undefined
let petSession: string | undefined
let requestedMode: 'work' | 'pet' | undefined
const appMode = ref<'work' | 'pet'>('work')
const petState = ref<PetState>({ active: false, action: 1, x: 128, fruit: 0, hour: 18, season: 0, queue: 0,
  scene: 0, activeToy: 0, toyPhase: 0 })
const petLinked = ref(false)
const petNotice = ref('')
const interactionNotice = ref('')
const interacting = ref(false)
const legacyPet = computed(() => petLinked.value && !petState.value.stats)
const sceneToys = computed(() => petToys.filter(toy => toy.scene === petScenes[petState.value.scene]))
const currentToy = computed(() => petToys.find(toy => toy.wireId === petState.value.activeToy))
const petParameterIds = ref<[PetParameter, PetParameter]>(['action', 'hour'])
const petImages = ref(['', ''])
const performanceValues = ref<number[]>([])
const performanceUnavailable = ref(false)
const petDialog = ref<HTMLDialogElement>()
const petScreen = ref(0)
const showPetAi = ref(false)
const fruitSelection = ref(1)
const pendingScene = new Map<number, number>()
let offlineBackground: number | undefined
let previewTimer: ReturnType<typeof setTimeout> | undefined
const hasPetPayload = (p?: Uint8Array) => p?.length === 12 || p?.length === 19
watch(petLinked, linked => {
  if (!linked) Object.assign(petState.value, { active: false, stats: undefined, activeToy: 0, toyPhase: 0, action: 1 })
})

function storeMode() {
  win.myApi.storageMenu('displayMode', appMode.value)
}

function setAppMode(mode: 'work' | 'pet') {
  if (appMode.value === mode) return
  requestedMode = mode
  appMode.value = mode
  storeMode()
  showDeviceScreens.value = false
  refreshPetDevice()
  liveScreens.tick()
}

function applyPetReply(reply: { session?: string; payload: Uint8Array }) {
  const p = reply.payload
  const previousScene = petState.value.scene
  clearTimeout(previewTimer)
  petSession = reply.session
  petLinked.value = true
  petNotice.value = ''
  petState.value = { active: p[0] === 1, action: p[1], x: p[2] | (p[3] << 8), fruit: p[8],
    hour: pendingScene.get(4) ?? p[9], season: pendingScene.get(5) ?? p[10], queue: p[11],
    stats: p.length === 19 ? { satiety: p[12], sleepiness: p[13], mood: p[14], affection: p[15] } : undefined,
    scene: p.length === 19 ? p[16] : 0,
    activeToy: p[17] ?? 0, toyPhase: p[18] ?? 0 }
  if (p.length === 19 && previousScene !== p[16]) saveSceneSettings()
}

function refreshPetDevice() {
  if (petTask || !conState.value || progressShow.value || firmwareUpdating.value) return
  petTask = (async () => {
    const status = await win.myApi.petAction(0)
    if (status.state === 'busy') return
    if (status.state !== 'ready' || !hasPetPayload(status.payload)) {
      petLinked.value = false
      petSession = undefined
      petNotice.value = status.state === 'unsupported' ? '键盘固件需要升级才能同步养宠模式。' : ''
      return
    }
    if (appMode.value === 'pet' && petSession !== status.session) requestedMode ??= 'pet'
    const actualMode = status.payload[0] ? 'pet' : 'work'
    if (requestedMode && actualMode !== requestedMode) {
      const target = requestedMode
      const result = await win.myApi.petAction(1, target === 'pet' ? 1 : 0)
      if (result.state === 'ready' && result.status === 0 && hasPetPayload(result.payload)) {
        if (requestedMode === target) requestedMode = undefined
        applyPetReply(result)
      }
      return
    }
    requestedMode = undefined
    applyPetReply(status)
    if (appMode.value !== actualMode) {
      if (actualMode === 'pet') showDeviceScreens.value = false
      appMode.value = actualMode
      storeMode()
    }
    if (actualMode === 'pet') {
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
  })().catch(() => { petLinked.value = false }).finally(() => { petTask = undefined })
}

function saveSceneSettings() {
  const { hour, season, scene } = petState.value
  win.myApi.storageMenu('petSceneSettings', JSON.stringify({ hour, season, scene, offlineBackground }))
}

function setScene(command: 4 | 5 | 6, event: Event) {
  const select = event.target as HTMLSelectElement
  const value = Number(select.value)
  interactionNotice.value = ''
  if (command === 6) {
    if (petLinked.value) {
      select.value = String(petState.value.scene)
      offlineBackground = undefined
    } else {
      clearTimeout(previewTimer)
      Object.assign(petState.value, { scene: value, activeToy: 0, toyPhase: 0, action: 1 })
      offlineBackground = value
    }
  } else petState.value[command === 4 ? 'hour' : 'season'] = value
  pendingScene.set(command, value)
  saveSceneSettings()
  refreshPetDevice()
}

function previewInteraction(command: number, value: number) {
  clearTimeout(previewTimer)
  if (command === 7) {
    Object.assign(petState.value, { activeToy: value, toyPhase: 1, action: 1, fruit: 0 })
    previewTimer = setTimeout(() => {
      Object.assign(petState.value, { toyPhase: 2, action: 2 })
      previewTimer = setTimeout(() => Object.assign(petState.value, { activeToy: 0, toyPhase: 0, action: 1 }), 4500)
    }, 2000)
    return
  }
  const action = command === 2 ? 3 : value
  Object.assign(petState.value, { action, activeToy: 0, toyPhase: 0, fruit: command === 2 ? value : 0 })
  if (action !== 2) {
    previewTimer = setTimeout(() => Object.assign(petState.value, { action: 1, fruit: 0 }),
      action === petActions.indexOf('gaze_owner') ? 3000 : 2050)
  }
}

async function interactWithPet(command: number, value: number) {
  if (interacting.value || progressShow.value || firmwareUpdating.value) return
  interacting.value = true
  interactionNotice.value = ''
  await petTask
  if (!petLinked.value) {
    if (conState.value) interactionNotice.value = petNotice.value || '等待读取键盘的宠物状态。'
    else previewInteraction(command, value)
    interacting.value = false
    return
  }
  petTask = (async () => {
    const result = await win.myApi.petAction(command, value)
    if (result.state === 'ready' && result.status === 0 && hasPetPayload(result.payload)) applyPetReply(result)
    else interactionNotice.value = result.status === 4 || result.state === 'busy'
      ? '兔子正在忙，请稍后再试。' : '键盘未确认这次操作，请检查连接和当前场景。'
  })().catch(() => { interactionNotice.value = '未能同步宠物操作。' }).finally(() => {
    petTask = undefined
    interacting.value = false
  })
  await petTask
}

function petContent(index: number) {
  const id = petParameterIds.value[index]
  const label = petParameters.find(item => item.id === id)!.label
  return { mode: 'pet', label, value: petValue(id, petState.value) } as const
}

watch(() => [appMode.value, petContent(0).value, petContent(1).value, ...petParameterIds.value],
  async (_current, _previous, onCleanup) => {
    if (appMode.value !== 'pet') return
    let stale = false
    onCleanup(() => { stale = true })
    const images = await Promise.all([renderScreenContent(petContent(0)), renderScreenContent(petContent(1))])
    if (!stale) petImages.value = images
  })

function configurePetScreen(screen: number) {
  petScreen.value = screen
  interactionNotice.value = ''
  showPetAi.value = false
  petDialog.value?.showModal()
}

function setPetParameter(event: Event) {
  petParameterIds.value[petScreen.value - 1] = (event.target as HTMLSelectElement).value as PetParameter
  win.myApi.storageMenu('petScreenParameters', JSON.stringify(petParameterIds.value))
  liveScreens.tick()
}

const test = async () => {
  console.info('test begin')
  let start = await win.myApi.waitSign()
  console.info(start)
  console.info('test end')
}

onMounted(async () => {
  // 获取解析菜单
  let jsonStr = await win.myApi.getMenu('configData')
  if(jsonStr != '' && jsonStr != undefined && jsonStr != null)
    parseMenuConfig(jsonStr)
  const savedMode = await win.myApi.getMenu('displayMode')
  if (savedMode === 'pet' || savedMode === 'work') {
    appMode.value = savedMode
    requestedMode = savedMode
  }
  try {
    const savedParameters = JSON.parse(await win.myApi.getMenu('petScreenParameters') || 'null')
    if (Array.isArray(savedParameters) && savedParameters.length === 2 &&
        savedParameters.every(id => petParameters.some(option => option.id === id))) petParameterIds.value = [savedParameters[0], savedParameters[1]]
  } catch { /* Fall back to the default OLED parameters. */ }
  try {
    const savedScene = JSON.parse(await win.myApi.getMenu('petSceneSettings') || 'null')
    if (Number.isInteger(savedScene?.hour) && savedScene.hour >= 0 && savedScene.hour < 24 &&
        Number.isInteger(savedScene?.season) && savedScene.season >= 0 && savedScene.season < 4) {
      petState.value = { ...petState.value, hour: savedScene.hour, season: savedScene.season }
      pendingScene.set(4, savedScene.hour)
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
  // 连接硬件
  conState.value = await testConnection()
  refreshDeviceScreens()
  screenPoll = setInterval(refreshDeviceScreens, 1800)
  buttonPoll = setInterval(refreshDeviceButtons, 45)
  liveScreens.tick()
  liveTimer = setInterval(() => {
    if (appMode.value === 'work' && hasPerformanceScreens()) void samplePerformance()
    liveScreens.tick()
  }, 1500)
  if (hasPerformanceScreens()) void samplePerformance()
  refreshPetDevice()
  petTimer = setInterval(refreshPetDevice, 700)
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
      if (objData.screenFrame) {
        const { menu, screen, frame } = objData.screenFrame as { menu: number; screen: number; frame: ScreenFrame }
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
        if (screen === 0 && frame.content?.mode === 'performance') void samplePerformance()
        liveScreens.tick()
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
  clearInterval(liveTimer)
  clearInterval(petTimer)
  clearTimeout(previewTimer)
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
  petSession = undefined
  conState.value = await testConnection()
  liveScreens.forgetDevice()
  liveScreens.tick()
  refreshDeviceScreens()
  refreshPetDevice()
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
const samplePerformance = async () => { performanceValues.value = await win.myApi.pcPerformance().catch(() => []) }
let performanceMenu = 0
const liveScreens = createLiveScreens(menu => appMode.value === 'work' || !petState.value.active
  ? configStore.menuConfig[menu]?.screenConfig
  : [{ baseData: '', buffData: [] }, ...[0, 1].map(index => ({ baseData: '', buffData: [], content: petContent(index) }))],
  () => progressShow.value || firmwareUpdating.value || Boolean(petTask), hasDynamicScreens,
  connected => {
    conState.value = connected
    if (!connected) {
      petLinked.value = false
      petSession = undefined
    }
  },
  async menu => {
    const enabled = appMode.value === 'work' && configStore.menuConfig[menu]?.screenConfig[0]?.content?.mode === 'performance'
    if (enabled && performanceValues.value.length !== 3) return
    if (!enabled && !performanceMenu) return
    const result = await win.myApi.livePerformance(enabled ? menu + 1 : 0,
      enabled ? [...performanceValues.value] : undefined)
    if (result === 'ready' || result === 'unsupported') performanceUnavailable.value = result === 'unsupported'
    if (result === 'ready') performanceMenu = enabled ? menu + 1 : 0
  }, () => appMode.value === 'pet' && petState.value.active)
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
// 发送最终数据
const sendFinalData = async () => {
  if (progressShow.value || firmwareUpdating.value) return
  const curMenu = configStore.curMenu
  configStore.setProgressMes(0)
  progressShow.value = true
  let ownsTransfer = false
  try {
    await Promise.all([screenReadTask, buttonReadTask, petTask, liveScreens.wait()])
    conState.value = await win.myApi.connectHardware()
    if (!conState.value) {
      XBox.popMes('硬件已经断开连接')
      return
    }
    await win.myApi.setDeviceConfiguring(true)
    ownsTransfer = true
    await sendMenu()
    const activeCount = configStore.activeMenu.filter(Boolean).length
    let count = 0
    for (let i = 0; i < 10; i++) {
      if (!configStore.activeMenu[i]) continue
      setMenu(i)
      await sendConfigData()
      count += 3
      configStore.setProgressMes(Math.ceil((count / activeCount) * 10))
      await sendOledScreen()
      count += 3
      configStore.setProgressMes(Math.ceil((count / activeCount) * 10))
      await sendColorScreen()
      count += 4
      configStore.setProgressMes(Math.ceil((count / activeCount) * 10))
    }
    configStore.setProgressMes(100)
    await win.myApi.setDeviceConfiguring(false)
    ownsTransfer = false
    if (hasDynamicScreens()) {
      const live = await win.myApi.liveOled().catch(() => undefined)
      if (live?.state === 'unsupported') XBox.popMes('当前固件需要升级后才能自动刷新小屏')
    }
    await new Promise((resolve) => setTimeout(resolve, 110))
  } catch (error) {
    console.error(error)
    XBox.popMes('发送中断，请检查 USB 连接后重试')
  } finally {
    if (ownsTransfer) await win.myApi.setDeviceConfiguring(false).catch(() => {})
    if (configStore.curMenu !== curMenu) setMenu(curMenu)
    progressShow.value = false
    liveScreens.tick()
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
  showDeviceScreens.value = false
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

// 显示屏幕编辑
const openScreenPage = (curScreen: number) => {
  if (appMode.value === 'pet') return configurePetScreen(curScreen)
  showDeviceScreens.value = false
  storageCurMenu()
  closeStorage()
  createWindow(`/screen?screen=${curScreen}&menu=${configStore.curMenu}`)
}

const showDeviceScreens = ref(true)
const deviceScreens = shallowRef<{ menu: number; generation: number; images: string[] }>()
const screenReadState = ref<DeviceScreens['state']>('disconnected')
let screenPoll: ReturnType<typeof setInterval> | undefined
let screenReadTask: Promise<void> | undefined

async function readDeviceScreens() {
  try {
    const result: DeviceScreens = await win.myApi.readDeviceScreens(deviceScreens.value?.generation)
    if (result.state === 'busy') return
    screenReadState.value = result.state
    if (result.state === 'ready') {
      deviceScreens.value = {
        menu: result.menu,
        generation: result.generation,
        images: renderDeviceScreens(result.pixels)
      }
    } else if (result.state !== 'unchanged') {
      deviceScreens.value = undefined
      if (result.state === 'disconnected') conState.value = false
    }
  } catch (error) {
    console.error(error)
    deviceScreens.value = undefined
    screenReadState.value = 'unavailable'
  }
}

function refreshDeviceScreens() {
  if (!conState.value || !showDeviceScreens.value || appMode.value === 'pet' || progressShow.value || firmwareUpdating.value || screenReadTask) return
  screenReadTask = readDeviceScreens().finally(() => { screenReadTask = undefined })
}

const screenSourceLabel = computed(() => {
  if (deviceScreens.value) {
    return showDeviceScreens.value ? `设备画面 · 第 ${deviceScreens.value.menu} 层` : '本机预览'
  }
  if (screenReadState.value === 'unsupported') return '固件不支持回读'
  if (screenReadState.value === 'empty') return '暂无设备画面'
  if (screenReadState.value === 'unavailable') return '画面读取失败'
  return '正在读取画面'
})

const screenPreviews = computed(() => {
  if (showDeviceScreens.value && deviceScreens.value) return deviceScreens.value.images
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
      screenReadState.value = 'disconnected'
    }
    return
  }

  heldButtons.value = result.held
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
  if (!conState.value || buttonSyncUnsupported || progressShow.value || firmwareUpdating.value || petTask || buttonReadTask) return
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
          <button v-if="conState && appMode === 'work'" class="screen-source" type="button"
            :aria-pressed="Boolean(deviceScreens && showDeviceScreens)"
            :title="deviceScreens ? '切换设备画面与本机预览' : undefined"
            @click="showDeviceScreens = !showDeviceScreens; refreshDeviceScreens()">
            {{ screenSourceLabel }}
          </button>
          <button class="firmware-update" type="button" :disabled="firmwareUpdating || progressShow"
            title="通过 USB 升级键盘固件" @click="updateFirmware">
            {{ firmwareUpdating ? '升级中' : 'USB 升级' }}
          </button>
          <div class="mode-switch" role="group" aria-label="显示模式">
            <button type="button" :aria-pressed="appMode === 'work'" :disabled="progressShow || firmwareUpdating" @click="setAppMode('work')">工作模式</button>
            <button type="button" :aria-pressed="appMode === 'pet'" :disabled="progressShow || firmwareUpdating" @click="setAppMode('pet')">养宠模式</button>
          </div>
        </div>
      </template>
    </WindowTitle>
    <div id="home-content">
      <div class="rotary-pair">
        <button class="rotary" :class="{ 'device-active': isDeviceButtonActive(8) }"
          type="button" title="配置旋钮 1" @click.stop="openConfigWindow(8)">旋钮 1</button>
        <button class="rotary" :class="{ 'device-active': isDeviceButtonActive(9) }"
          type="button" title="配置旋钮 2" @click.stop="openConfigWindow(9)">旋钮 2</button>
      </div>
      <div class="screen-panel">
        <button v-for="(label, index) in screenLabels" :key="label" class="screen-card" type="button"
          :title="appMode === 'pet' ? (index ? `设置${label}宠物参数` : '打开宠物设置') : `编辑${label}内容`" @click="openScreenPage(index)">
          <span class="screen-image">
            <PetDisplay v-if="appMode === 'pet' && index === 0" :state="petState" :connected="petLinked && petState.active" />
            <img v-else-if="appMode === 'pet' && index && petImages[index - 1]" :src="petImages[index - 1]" alt="" />
            <PerformanceDisplay v-else-if="index === 0 && configStore.screenData[0].content?.mode === 'performance'"
              :values="performanceValues" />
            <img v-else-if="appMode === 'work' && screenPreviews[index]" :src="screenPreviews[index]" alt="" />
          </span>
          <span>{{ appMode === 'pet' ? (index ? petContent(index - 1).label : '宠物设置') : label }}</span>
        </button>
        <div v-if="appMode === 'pet'" class="mode-status" role="status">
          {{ petNotice || (petLinked && petState.active ? '键盘养宠模式已同步' : '本机宠物预览') }}
        </div>
        <div v-else class="layer-actions">
          <button id="send-box" type="button" :disabled="progressShow || firmwareUpdating"
            @click="sendFinalData">发送到键盘</button>
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
          :title="`配置 K${index + 1}`" @click.stop="openConfigWindow(index)">K{{ index + 1 }}</button>
      </div>
      <button class="rotary rotary-large" type="button" title="配置旋钮 3"
        :class="{ 'device-active': isDeviceButtonActive(10) }"
        @click.stop="openConfigWindow(10)">旋钮 3</button>
    </div>
    <p v-if="appMode === 'work' && performanceUnavailable && configStore.screenData[0].content?.mode === 'performance'"
      class="firmware-hint" role="status">彩屏性能监测需要升级键盘固件。</p>
    <dialog ref="petDialog" class="pet-dialog" @close="showPetAi = false">
      <form method="dialog">
        <header>
          <h2>{{ showPetAi ? 'AI 控制' : petScreen === 0 ? '宠物设置' : screenLabels[petScreen] + ' · 宠物参数' }}</h2>
          <button v-if="showPetAi" type="button" @click="showPetAi = false">返回宠物设置</button>
          <button v-else type="submit">完成</button>
        </header>
        <PetAiSettings v-if="showPetAi" :device-ready="petLinked && petState.active" />
        <template v-else-if="petScreen === 0">
          <PetDisplay :state="petState" :connected="petLinked && petState.active" />
          <dl class="pet-stats" aria-label="宠物属性，满值一百">
            <div v-for="stat in petStats" :key="stat.id">
              <dt>{{ stat.label }}</dt>
              <dd>{{ petValue(stat.id, petState) }}<small v-if="petState.stats"> / 100</small></dd>
            </div>
          </dl>
          <div class="pet-fields">
            <label>宠物场景
              <select :value="petState.scene" :disabled="legacyPet" @change="setScene(6, $event)">
                <option v-for="(scene, index) in petScenes" :key="scene" :value="index">{{ petSceneLabels[scene] }}</option>
              </select>
            </label>
            <label>场景时间
              <select :value="petState.hour" @change="setScene(4, $event)">
                <option v-for="hour in 24" :key="hour" :value="hour - 1">{{ String(hour - 1).padStart(2, '0') }}:00</option>
              </select>
            </label>
            <label>季节
              <select :value="petState.season" @change="setScene(5, $event)">
                <option v-for="(season, index) in petSeasons" :key="season" :value="index">{{ season }}</option>
              </select>
            </label>
            <label>投喂水果
              <select v-model.number="fruitSelection">
                <option v-for="(fruit, index) in petFruits.slice(1)" :key="fruit" :value="index + 1">{{ fruit }}</option>
              </select>
            </label>
            <button type="button" @click="showPetAi = true">AI 控制</button>
            <button type="button" :disabled="interacting" @click="interactWithPet(2, fruitSelection)">投喂</button>
            <button type="button" :disabled="interacting || !!currentToy" @click="interactWithPet(3, petState.action === 2 ? 0 : 2)">{{ petState.action === 2 ? '叫醒' : '睡觉' }}</button>
          </div>
          <div class="pet-fields" role="group" aria-label="宠物互动">
            <button v-for="action in (['trip_angry', 'gaze_owner'] as const)" :key="action"
              type="button" :disabled="legacyPet || interacting || !!currentToy"
              @click="interactWithPet(3, petActions.indexOf(action))">{{ petActionLabels[action] }}</button>
            <button v-for="toy in sceneToys" :key="toy.id" type="button" :title="toy.description"
              :disabled="legacyPet || interacting || !!currentToy" @click="interactWithPet(7, toy.wireId)">
              {{ '使用' + toy.label }}
            </button>
          </div>
          <p v-if="currentToy" role="status">{{ petState.toyPhase === 1 ? '正在走向' : '正在使用' }}{{ currentToy.label }}</p>
          <p v-if="interactionNotice || petNotice" role="status">{{ interactionNotice || petNotice }}</p>
          <p v-else-if="legacyPet">升级键盘固件即可启用新动作、场景玩具和宠物属性。</p>
          <p v-else-if="!petLinked">本机预览 · 连接键盘后可读取宠物属性。</p>
        </template>
        <label v-else>显示参数
          <select :value="petParameterIds[petScreen - 1]" @change="setPetParameter">
            <option v-for="option in petParameters" :key="option.id" :value="option.id"
              :disabled="legacyPet && petStats.some(stat => stat.id === option.id)">{{ option.label }}</option>
          </select>
          <span v-if="legacyPet">升级键盘固件即可显示宠物属性。</span>
        </label>
      </form>
    </dialog>
    <ProgressBox v-if="progressShow" />
  </div>
</template>

<style lang="scss" scoped>
.mode-switch { -webkit-app-region: no-drag; display: inline-flex; gap: 2px; margin-left: auto; padding: 2px; background: #dce5e8; border-radius: 8px; }
.mode-switch button { padding: 4px 7px; border: 0; border-radius: 6px; font: inherit; font-size: 12px; white-space: nowrap; color: #263d46; background: transparent; cursor: pointer; }
.mode-switch button[aria-pressed="true"] { color: white; background: #263d46; }
.mode-status { grid-column: 1 / -1; align-self: center; font-size: 12px; color: #405058; }
.firmware-hint { position: absolute; bottom: 0; left: 22px; margin: 0; font-size: 12px; }
.pet-dialog { box-sizing: border-box; width: min(450px, 92%); max-height: calc(100vh - 28px); overflow: auto; padding: 18px; color: #24323a; border: 1px solid #aab7bd; border-radius: 14px; background: #f7fafb; }
.pet-dialog::backdrop { background: #15222d80; }
.pet-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.pet-dialog h2 { margin: 0; font-size: 18px; }
.pet-dialog canvas { height: auto; border-radius: 8px; }
.pet-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-top: 12px; }
.pet-stats { display: grid; grid-template-columns: repeat(4, 1fr); margin: 10px 0 0; padding: 8px 10px; border-radius: 7px; background: #e7efed; }
.pet-stats dt { color: #4d625c; font-size: 12px; }
.pet-stats dd { margin: 2px 0 0; font-size: 16px; font-variant-numeric: tabular-nums; }
.pet-stats small { color: #52665f; font-size: 10px; }
.pet-dialog label { display: grid; gap: 4px; font-size: 13px; }
.pet-dialog button, .pet-dialog select { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid #aab7bd; background: white; color: inherit; }
.pet-dialog button { cursor: pointer; }
.pet-dialog :disabled { opacity: .55; cursor: default; }
.pet-dialog p { margin: 8px 0 0; font-size: 12px; }
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
  gap: 10px;
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

.connection-state, .screen-source, .firmware-update {
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
.home-toolbar .screen-source,
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

.screen-source {
  margin-left: auto;

  &[aria-pressed='true'] {
    background: #dcebe6;
    color: #234936;
  }
}

.firmware-update {
  background: #dbe3e4;
}

.home-toolbar .connection-state + .firmware-update {
  margin-left: auto;
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

#home-content #send-box {
  min-height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  background: #244c49;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;

  &:hover:not(:disabled) { background: #32645e; }
  &:disabled { background: #506a68; }
}

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
  border-radius: 12px;
  background: #3d454f;
  color: #f4f6f7;
  font-size: 17px;
  font-weight: 600;

  &:hover { background: #4c5965; }
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
