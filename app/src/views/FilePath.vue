<script setup lang="ts">
import { onMounted, ref } from "vue"
import { genCompStr, toHexStr } from '../utils/strTools'
import { useConfigStore } from '../stores/configStore'
import { XBox } from 'ilx1-x-box'

const win = window as any
const configStore = useConfigStore()

const getFilePath = async () => {
  let filePath = await win.myApi.getFilePath()
  if(filePath != undefined)
  filePathStr.value = filePath.filePaths[0]
}

const filePathStr = ref<string>('')

const commit = () => {
  if(filePathStr.value == '') {
    XBox.popMes('没有选择路径或路径选择错误')
    return
  }
  let compStr = genCompStr(filePathStr.value)
  if((/error/g).test(compStr)) {
    XBox.popMes(compStr)
    return
  }
  let strLen = toHexStr(parseInt(`0x${compStr.substring(0, 2)}`))
  // 31010801150300 03000404050607020404050607000404050607
  // 31010801150300 0B 0202 0733 0001 31 0201 18 0005 1608151631 0201 04 000D 07100C110C1617150417121531 0201 07 0007 08160E17121331 0207 0B0C072E060706 0004 37130709
  let genKeyStr = `31010801150300${strLen}${compStr.substring(2)}000128`
  console.info(genKeyStr)

  configStore.keyConfig[configStore.curEvent] = {
    userKey: filePathStr.value,
    genKey: genKeyStr
  }
  console.info(configStore.keyConfig[configStore.curEvent])
  configStore.setFuncShow(false)
}
</script>

<template>
  <div id="file-path-content">
    <h3>选择文件或应用路径</h3>
    <button type="button" class="settings-button path-picker" @click="getFilePath">{{ filePathStr || '选择文件' }}</button>
    <div class="actions">
      <button type="button" class="settings-button is-primary" :disabled="!filePathStr" @click="commit">确认</button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
#file-path-content { width:min(460px,90%); padding:16px; }
h3 { margin-bottom:10px; font-size:15px; }
.path-picker { display:block; width:100%; padding:12px; text-align:left; overflow-wrap:anywhere; }
.actions { display:flex; justify-content:flex-end; margin-top:13px; }
</style>
