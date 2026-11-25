<script setup lang="ts">
import { ref, watch } from 'vue'
import { useConfigStore } from '../stores/configStore'
import { getStringMap } from '../utils/hidKeyCode'
import { toHexStr } from '../utils/strTools'
import { XBox } from 'ilx1-x-box'

const configStore = useConfigStore()

const textCount = ref<number>(0)
const textValue = ref<string>('')

const COUNT_VALUE = 100

// 文本字数限制
watch(
  () => textValue.value,
  () => {
    textCount.value = textValue.value.length
    if (textCount.value > COUNT_VALUE) textValue.value = textValue.value.substring(0, 255)
  }
)
// 提交
const commit = () => {
  if (textValue.value == '') {
    XBox.popMes('没有输入任何内容')
    return
  }
  let genKeyStr: string = ''
  let state: number = 0
  let tempStr: string = ''
  let keyCount: number = 0

  try {
    for (let i = 0; i < textValue.value.length; i++) {
      // 特殊键值
      if (!/\r|\n/.test(textValue.value[i])) {
        if (/[A-Z]/.test(textValue.value[i]) || getStringMap().get(textValue.value[i]).kind > 1) {
          if (state != 3 && state != 0) {
            genKeyStr += `00${toHexStr(tempStr.length / 2)}${tempStr}`
            tempStr = ''
            keyCount++
          }
          state = 3
          tempStr += getStringMap().get(textValue.value[i]).hex
          continue
        }
      }
      // 普通键值
      if (state != 2 && state != 0) {
        genKeyStr += `02${toHexStr(tempStr.length / 2)}${tempStr}`
        tempStr = ''
        keyCount++
      }
      state = 2
      if (/\r|\n/.test(textValue.value[i])) {
        tempStr += getStringMap().get('Enter').hex
        continue
      }
      tempStr += getStringMap().get(textValue.value[i]).hex
    }
    if (state == 2) {
      genKeyStr += `00${toHexStr(tempStr.length / 2)}${tempStr}`
    }
    if (state == 3) {
      genKeyStr += `02${toHexStr(tempStr.length / 2)}${tempStr}`
    }
    genKeyStr = `1${toHexStr(++keyCount)}${genKeyStr}`
  } catch (error) {
    XBox.popMes('有错误产生，可能有不支持的字符')
    return
  }
  console.info(genKeyStr)
  configStore.keyConfig[configStore.curEvent] = {
    userKey: textValue.value,
    genKey: genKeyStr
  }
  console.info(configStore.keyConfig[configStore.curEvent])
  configStore.setFuncShow(false)
}
</script>

<template>
  <div id="send-text-content">
    <label>发送文本
      <textarea class="settings-field" rows="5" v-model="textValue" spellcheck="false"></textarea>
    </label>
    <div class="actions">
      <small>{{ textCount }} / 100</small>
      <button type="button" class="settings-button is-primary" @click="commit">确认</button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
#send-text-content { width:min(480px,90%); padding:16px; }
label { display:grid; gap:9px; font-weight:650; }
textarea { resize:vertical; min-height:96px; font-weight:400; }
.actions { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:10px; }
small { color:var(--settings-muted); }
</style>
