const { app, protocol, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron')
// 需在当前文件内开头引入 Node.js 的 'path' 模块
const path = require('path')

import { windowControlListener } from '../controller/windowControl'
import CreateWindow from '../controller/createWindow'
import { getFilePath, getConfigFile, writeConfigFile } from '../controller/fileDialog'
import SerialConnect from '../controller/serialPort'
import { readPcPerformance } from '../controller/pcPerformance'
import { picDataListener } from '../controller/picDataEditor'
import { setItem, getItem, delItem } from "../controller/storage"
import { fileReadListener } from "../controller/fileRead"
import { fetchScreenValue } from '../controller/screenApi'
import { startPetMcp } from '../controller/petMcp'
import { isStatCommand, isStatValue, isHeadPetInput, furniturePositionValid, petFurniture, petFruitIds,
  petBuySnackCommand, petLampCommand, petToggleLampCommand } from '../../src/utils/petCatalog'
import { getPetAiActivity, observePetAiSession, observePetOwnerCommand, getPetAi, savePetAi, startPetAi, stopPetAi, testPetAi } from '../controller/petAi'
import type { BrowserWindow as ElectronWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { PetSettingsAction, PetSettingsSnapshot } from '../../src/utils/petSettings'

// A detached Windows launcher can close its logging pipes while MultiPad is open.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}

// 窗口监听
windowControlListener()
// 图片处理监听
picDataListener()
// 文件读取
fileReadListener()

ipcMain.on('set-item', (event, name: string, item: string) => {
  setItem(name, item)
})

ipcMain.on('del-item', (event, name: string) => {
  delItem(name)
})

ipcMain.handle('get-item', async (event, name: string) => {
  return await getItem(name)
})


// 跳转到下载页面
ipcMain.on('latest-download', (event, link: string) => {
  shell.openExternal(link)
})

// 创建其他窗口
ipcMain.on('window-create', (event, optionObj: object, configObj: object) => {
  let cw = new CreateWindow()
  cw.createWindow(optionObj, configObj)
})

// 选择文件夹
ipcMain.handle('write-config', async (event, fileName: string, context: string) => {
  return await writeConfigFile(fileName, context)
})

// 选取文件
ipcMain.handle('select-file', async () => {
  return await getFilePath()
})

// 选取配置文件
ipcMain.handle('get-config', async () => {
  return await getConfigFile()
})

// pinia
ipcMain.on('store-set', (event, objData) => {
  // 遍历窗口发送
  for(const cur of BrowserWindow.getAllWindows()) {
    if(cur != BrowserWindow.fromWebContents(event.sender)) {
      cur.webContents.send('store-get', objData)
    }
  }
})

// 等待信号
ipcMain.handle('wait-sign', async () => {
  return await SerialConnect.waitSign()
})

// 硬件连接
ipcMain.handle('connection-state', async () => {
  // 创建窗口之后连接硬件
  const connected = await SerialConnect.connectHardware()
  if (!connected) observePetAiSession(null)
  return connected
})

// 发送数据
ipcMain.handle('device-screens', (_event, knownGeneration?: number) => {
  return SerialConnect.readDeviceScreens(knownGeneration)
})

ipcMain.handle('device-buttons', () => SerialConnect.readDeviceButtons())
ipcMain.handle('pc-performance', () => readPcPerformance())
ipcMain.handle('pc-performance-preview', (_event, menu: number) =>
  SerialConnect.displayedPerformance(menu) ?? readPcPerformance())
ipcMain.handle('live-performance', (_event, menu, metrics) => SerialConnect.performance(menu, metrics))
ipcMain.handle('pet-action', async (event, command, value) => {
  const furniture = petFurniture.find(item => item.command === command)
  if (!Number.isInteger(command) || command < 0 || (command > 15 && command !== 22 && command !== petLampCommand &&
      command !== petBuySnackCommand && command !== petToggleLampCommand && !furniture && !isStatCommand(command)) ||
      !Number.isInteger(value) || value < 0 || value > (furniture ? 0x1ffff : command === 10 ? 1439 : 255) ||
      (furniture && !furniturePositionValid(furniture, value & 511, value >> 9)) || (command === 15 && value !== 0) ||
      (command === petBuySnackCommand && (value < 1 || value > petFruitIds.length)) ||
      (command === petToggleLampCommand && value !== 0) ||
      (isStatCommand(command) && !isStatValue(value)) || (command === petLampCommand && value > 1) ||
      (command === 22 && !isHeadPetInput(value)) ||
      (command === 8 && ((value >> 4) > 7 || (value & 15) > 10)) ||
      (command === 9 && value > 1) || (command === 12 && value > 7) ||
      ((command === 11 || command === 13) && (value < 1 || value > 2))) return { state: 'unavailable' }
  if (command >= 8) fromHome(event)
  const reply = await SerialConnect.pet({ command, value })
  if ((command === 0 || command === 1) && reply.state === 'ready' && reply.status === 0 && reply.session) {
    observePetAiSession(reply.payload[0] ? reply.session : null)
  } else if (reply.state === 'disconnected') {
    observePetAiSession(null)
  }
  if (reply.state === 'ready' && reply.status === 0 && reply.session && event.sender === mainContents) {
    observePetOwnerCommand(reply.session, command, value, reply.payload)
  }
  return reply.state === 'ready' ? { ...reply, payload: Uint8Array.from(reply.payload) } : reply
})
let mainContents: WebContents | undefined
function isFromHome(event: IpcMainInvokeEvent | IpcMainEvent) {
  const frame = event.senderFrame
  return event.sender === mainContents && frame && frame === event.sender.mainFrame && new URL(frame.url).hash === '#/home'
}
function fromHome(event: IpcMainInvokeEvent | IpcMainEvent) {
  if (!isFromHome(event)) throw Error('请在 MultiPad 主窗口使用宠物设置')
}

let petSettingsWindow: ElectronWindow | undefined
let petSettingsSnapshot: PetSettingsSnapshot | undefined
let nextSettingsRequest = 0
const settingsRequests = new Map<number, (result: boolean) => void>()

function fromPetSettings(event: IpcMainInvokeEvent | IpcMainEvent) {
  const frame = event.senderFrame
  return Boolean(petSettingsWindow && !petSettingsWindow.isDestroyed() &&
    event.sender === petSettingsWindow.webContents && frame && frame === event.sender.mainFrame &&
    new URL(frame.url).hash === '#/pet-settings')
}

function publishPetSettings() {
  if (petSettingsWindow && !petSettingsWindow.isDestroyed() && petSettingsSnapshot)
    petSettingsWindow.webContents.send('pet-settings-snapshot', petSettingsSnapshot)
}

ipcMain.handle('pet-settings-open', (event: IpcMainInvokeEvent, snapshot: PetSettingsSnapshot) => {
  fromHome(event)
  petSettingsSnapshot = snapshot
  if (petSettingsWindow && !petSettingsWindow.isDestroyed()) {
    publishPetSettings()
    if (petSettingsWindow.isMinimized()) petSettingsWindow.restore()
    petSettingsWindow.focus()
    return
  }
  const homeWindow = BrowserWindow.fromWebContents(event.sender)
  const area = (homeWindow ? screen.getDisplayMatching(homeWindow.getBounds()) : screen.getPrimaryDisplay()).workAreaSize
  petSettingsWindow = new CreateWindow().createWindow({ route: '/pet-settings' }, {
    width: Math.min(920, area.width), height: Math.min(710, area.height),
    minWidth: Math.min(680, area.width), minHeight: Math.min(500, area.height),
    modal: false, parent: undefined, title: '宠物设置'
  })
  petSettingsWindow.once('closed', () => {
    petSettingsWindow = undefined
    petSettingsSnapshot = undefined
    for (const finish of settingsRequests.values()) finish(false)
    if (mainContents && !mainContents.isDestroyed()) mainContents.send('pet-settings-closed')
  })
})
ipcMain.on('pet-settings-subscribe', (event: IpcMainEvent) => {
  if (fromPetSettings(event)) publishPetSettings()
})
ipcMain.on('pet-settings-update', (event: IpcMainEvent, snapshot: PetSettingsSnapshot) => {
  if (!isFromHome(event) || !petSettingsWindow) return
  petSettingsSnapshot = snapshot
  publishPetSettings()
})
ipcMain.handle('pet-settings-action', (event: IpcMainInvokeEvent, action: PetSettingsAction) => {
  if (!fromPetSettings(event) || !Array.isArray(action) || !mainContents || mainContents.isDestroyed()) return false
  const owner = mainContents
  return new Promise<boolean>(resolve => {
    const id = ++nextSettingsRequest
    const finish = (result: boolean) => {
      clearTimeout(timeout)
      settingsRequests.delete(id)
      resolve(result)
    }
    const timeout = setTimeout(() => finish(false), 10_000)
    settingsRequests.set(id, finish)
    owner.send('pet-settings-command', id, action)
  })
})
ipcMain.on('pet-settings-result', (event: IpcMainEvent, id: number, applied: boolean) => {
  if (!isFromHome(event)) return
  settingsRequests.get(id)?.(applied === true)
})

function fromPetAiSettings(event: IpcMainInvokeEvent) {
  if (!fromPetSettings(event)) fromHome(event)
}
ipcMain.handle('pet-ai-activity-get', (event: IpcMainInvokeEvent) => {
  fromHome(event)
  return getPetAiActivity()
})
ipcMain.handle('pet-ai-get', (event: IpcMainInvokeEvent) => {
  fromPetAiSettings(event)
  return getPetAi()
})
ipcMain.handle('pet-ai-save', (event: IpcMainInvokeEvent, settings: unknown) => {
  fromPetAiSettings(event)
  return savePetAi(settings)
})
ipcMain.handle('pet-ai-test', (event: IpcMainInvokeEvent, kind: unknown) => {
  fromPetAiSettings(event)
  if (kind !== 'connection' && kind !== 'blink') throw Error('无效的测试项目')
  return testPetAi(kind)
})
ipcMain.handle('live-oled', (_event, operation) => SerialConnect.liveOled(operation))
ipcMain.handle('screen-api-value', (_event, url: unknown, field: unknown) => fetchScreenValue(url, field))

ipcMain.handle('update-firmware', async (event) => {
  const options = {
    title: '选择 MultiPad USB 升级固件',
    filters: [{ name: 'USB 升级固件', extensions: ['bin'] }],
    properties: ['openFile']
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return { state: 'cancelled' }
  try {
    const { updateFirmware } = require(path.join(__dirname, '../../scripts/firmware-update.cjs'))
    await SerialConnect.withFirmwareUpdate(() => updateFirmware(result.filePaths[0], console.info))
    return { state: 'updated' }
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('send-data', async (event, data: string | Uint8Array) => {
  return await SerialConnect.sendData(data)
})

let configOwner: WebContents | undefined
const releaseConfiguration = () => {
  configOwner = undefined
  void SerialConnect.setConfiguring(false)
}
ipcMain.handle('device-configuring', async (event, enabled: boolean) => {
  const sender = event.sender
  if (!enabled) {
    if (configOwner === sender) {
      sender.removeListener('destroyed', releaseConfiguration)
      releaseConfiguration()
    }
    return
  }
  if (configOwner) throw Error('键盘配置正在发送')
  configOwner = sender
  sender.once('destroyed', releaseConfiguration)
  try {
    await SerialConnect.setConfiguring(true)
  } catch (error) {
    sender.removeListener('destroyed', releaseConfiguration)
    if (configOwner === sender) configOwner = undefined
    throw error
  }
})

ipcMain.handle('device-work-layout', async (event: IpcMainInvokeEvent) => {
  fromHome(event)
  if (event.sender !== configOwner) return { state: 'busy' }
  return SerialConnect.readWorkLayout()
})

// 创建主窗口
const createMainWindow = async () => {
  let mainW = new CreateWindow()
  const window = mainW.createWindow({
    route: '/home',
    isMainWin: true,
  }, {
    width: 680,
    height: 500,
    maxWidth: 680,
    maxHeight: 500,
    resizable: false,
    maximizable: false,
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
  })
  if (window) mainContents = window.webContents
}

app.commandLine.appendSwitch('--ignore-certificate-errors', 'true')
// Scheme must be registered before the app is ready
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { secure: true, standard: true } }])

app.whenReady().then(() => {
  try {
    const petMcp = startPetMcp()
    if (petMcp) app.once('before-quit', () => petMcp.close())
  } catch (error) {
    console.error('MultiPad MCP startup failed', error)
  }
  startPetAi(activity => {
    if (mainContents && !mainContents.isDestroyed()) mainContents.send('pet-ai-activity', activity)
  })
  app.once('before-quit', stopPetAi)
  // 创建窗口
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// 关闭所有窗口
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
