import { useConfigStore } from '../stores/configStore'
import { XBox } from 'ilx1-x-box'

const configStore = useConfigStore()
const win = window as any

export const testConnection = async (): Promise<boolean> => {
  // console.info(conStore)
  if (await win.myApi.connectHardware()) {
    XBox.popMes('连接成功')
    return new Promise((resolve) => resolve(true))
  } else {
    XBox.popMes('连接失败，请检查硬件连接')
    return new Promise((resolve) => resolve(false))
  }
}

// 重置数据
export const resetData = () => {
  // 清空屏幕配置数组
  for (let i = 0; i < 3; i++) {
    configStore.setCurScreen(i)
    let temp = {
      baseData: '',
      buffData: []
    }
    configStore.setScreenData(JSON.stringify(temp))
  }
  // 清空键值配置数组
  for (let i = 0; i < 11; i++) {
    configStore.setConfigIndex(i)
    configStore.setLayerKeyConfig(JSON.stringify([]))
  }
}

// 赋值数据
export const loadMenu = () => {
  // 赋值数据
  if (configStore.menuConfig[configStore.curMenu].screenConfig) {
    let temp = {
      screenData: configStore.menuConfig[configStore.curMenu].screenConfig,
      keyData: configStore.menuConfig[configStore.curMenu].keyConfig
    }
    // console.info(temp.screenData)
    if (temp.screenData.length != 0) {
      for (let i = 0; i < 3; i++) {
        configStore.setCurScreen(i)
        const curScreen = temp.screenData[i] ?? { baseData: '', buffData: [] }
        configStore.setScreenData(JSON.stringify(curScreen))
      }
    }
    if (temp.keyData.length != 0) {
      for (let i = 0; i < 11; i++) {
        configStore.setConfigIndex(i)
        let curKey = temp.keyData[i]
        configStore.setLayerKeyConfig(JSON.stringify(curKey))
      }
    }
  }
}

// 解析配置文件并赋值
export const parseMenuConfig = (jsonStr: string) => {
  let jsonObj = JSON.parse(jsonStr)
  for(let i = 0; i < 10; i ++) {
    configStore.setCurMenu(i)
    let tempObj = {
      keyConfig: jsonObj[i].keyConfig || [],
      screenConfig: jsonObj[i].screenConfig || []
    }
    // 存储在全层数据
    configStore.setMenuConfig(JSON.stringify(tempObj))
  }
  // 显示菜单
  resetData()
  configStore.setCurMenu(0)
  loadMenu()
}
