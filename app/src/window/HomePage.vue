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
import type { ScreenFrame } from '../components/screenPage/screenContent'

const router = useRouter()
const win = window as any
const configStore = useConfigStore()
const menuStore = useMenuStore()
const popBoxRef = ref<HTMLElement | null>(null)
let liveTimer: ReturnType<typeof setInterval> | undefined

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
  // console.info(jsonStr)
  // 连接硬件
  conState.value = await testConnection()
  refreshDeviceScreens()
  screenPoll = setInterval(refreshDeviceScreens, 1800)
  buttonPoll = setInterval(refreshDeviceButtons, 45)
  liveScreens.tick()
  liveTimer = setInterval(() => liveScreens.tick(), 2000)
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

const openPetPreview = () => createWindow('/pet', {
  title: 'MultiPad 桌宠',
  width: 680,
  height: 520,
  minWidth: 680,
  minHeight: 520,
  resizable: false,
  maximizable: false
})

// 连接状态
const conState = ref<boolean>(false)
// 手动重新连接
const titleClick = async () => {
  buttonSyncUnsupported = false
  conState.value = await testConnection()
  liveScreens.forgetDevice()
  liveScreens.tick()
  refreshDeviceScreens()
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
const hasDynamicScreens = () => configStore.menuConfig.some(menu => menu.screenConfig.some((screen: ScreenFrame) =>
  screen?.content && screen.content.mode !== 'text'))
const liveScreens = createLiveScreens(menu => configStore.menuConfig[menu]?.screenConfig,
  () => progressShow.value || firmwareUpdating.value, hasDynamicScreens,
  connected => { conState.value = connected })
const updateFirmware = async () => {
  if (firmwareUpdating.value || progressShow.value) return
  firmwareUpdating.value = true
  try {
    await Promise.all([screenReadTask, buttonReadTask, liveScreens.wait()])
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
    await Promise.all([screenReadTask, buttonReadTask, liveScreens.wait()])
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
  if (!conState.value || progressShow.value || firmwareUpdating.value || screenReadTask) return
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
  if (!conState.value || buttonSyncUnsupported || progressShow.value || firmwareUpdating.value || buttonReadTask) return
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
          <button v-if="conState" class="screen-source" type="button"
            :disabled="!deviceScreens" :aria-pressed="Boolean(deviceScreens && showDeviceScreens)"
            :title="deviceScreens ? '切换设备画面与本机预览' : undefined"
            @click="showDeviceScreens = !showDeviceScreens">
            {{ screenSourceLabel }}
          </button>
          <button class="firmware-update" type="button" :disabled="firmwareUpdating || progressShow"
            title="通过 USB 升级键盘固件" @click="updateFirmware">
            {{ firmwareUpdating ? '升级中' : 'USB 升级' }}
          </button>
          <button class="pet-preview-button" type="button" @click="openPetPreview">桌宠</button>
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
          :title="`编辑${label}内容`" @click="openScreenPage(index)">
          <span class="screen-image">
            <img v-if="screenPreviews[index]" :src="screenPreviews[index]" alt="" />
          </span>
          <span>{{ label }}</span>
        </button>
        <div class="layer-actions">
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
    <ProgressBox v-if="progressShow" />
  </div>
</template>

<style lang="scss" scoped>
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

.connection-state, .screen-source, .firmware-update, .pet-preview-button {
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
.home-toolbar .firmware-update,
.home-toolbar .pet-preview-button {
  font-size: 13px;
  font-weight: 600;

  &:hover:not(:disabled) {
    background: #fff;
  }
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
