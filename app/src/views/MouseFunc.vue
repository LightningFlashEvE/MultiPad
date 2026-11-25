<script setup lang="ts">
import { reactive, watch } from 'vue'
import { useConfigStore } from '../stores/configStore'
import { toHexStr } from '../utils/strTools'
import { XBox } from 'ilx1-x-box'

const configStore = useConfigStore()

const mouseArray = reactive([
  {
    eventId: 0,
    eventName: '左键点击',
    isSelect: false,
  },
  {
    eventId: 1,
    eventName: '中键点击',
    isSelect: false,
  },
  {
    eventId: 2,
    eventName: '右键点击',
    isSelect: false,
  },
])

const mouseEvent = reactive({
  mouseLeft: '',
  mouseRight: '',
  mouseUp: '',
  mouseDown: '',
  rollDown: '',
  rollUp: '',
})

watch(
  [() => mouseEvent.mouseLeft, () => mouseEvent.mouseRight, () => mouseEvent.mouseUp, () => mouseEvent.mouseDown, () => mouseEvent.rollDown, () => mouseEvent.rollUp],
  (newVal, oldVal) => {
    for (let key in newVal) {
      if (newVal[key] != oldVal[key]) {
        // 限制数值
        if (newVal[key] > 255) {
          XBox.popMes('输入的值不能大于 255')
          mouseEvent[Object.keys(mouseEvent)[key]] = ''
        }
        // 限制双向
        if (newVal[key] != '') {
          let setKey = Number(key)
          setKey += setKey % 2 == 0 ? 1 : -1
          mouseEvent[Object.keys(mouseEvent)[setKey]] = ''
        }
      }
    }
  },
  {
    deep: true,
  }
)

const mouseKeyArray = [0x01, 0x04, 0x02]

const commit = () => {
  let genKeyStr: string = ''
  let userKeyStr: string = ''
  let mouseKey: number = 0x00

  mouseArray.forEach((o) => {
    if (o.isSelect) {
      mouseKey += mouseKeyArray[o.eventId]
      userKeyStr += `${o.eventName}<br>`
    }
  })
  genKeyStr = `4${toHexStr(mouseKey)}`
  let sign = 0
  const evenStr = ['向左移动', '向右移动', '向上移动', '向下移动','向下滚动', '向上滚动']
  const gen = Object.keys(mouseEvent).reduce((pre, cur, index) => {
    console.info(mouseEvent)
    console.info(cur)
    if(mouseEvent[cur] != '') {
      pre.genkey += `${String(index % 2)}${toHexStr(Number(mouseEvent[cur]))}` 
      pre.userKey += `${evenStr[index]} -> ${mouseEvent[cur]}<br>`
      sign = 1
    }
    if(index % 2) {
      if(sign == 0) {
        pre.genkey += `000`
      }
      sign = 0
    }
    return pre
  }, {
    genkey: '',
    userKey: ''
  })
  genKeyStr += gen.genkey
  userKeyStr += gen.userKey

  configStore.keyConfig[configStore.curEvent] = {
    userKey: userKeyStr,
    genKey: genKeyStr,
  }
  console.info(configStore.keyConfig[configStore.curEvent])
  configStore.setFuncShow(false)
}
</script>

<template>
  <form id="mouse-func-content" @submit.prevent="commit">
    <h3>鼠标控制</h3>
    <fieldset>
      <legend>移动距离</legend>
      <div class="fields">
        <label>向左<input v-model.number="mouseEvent.mouseLeft" class="settings-field" type="number" min="0" max="255"></label>
        <label>向右<input v-model.number="mouseEvent.mouseRight" class="settings-field" type="number" min="0" max="255"></label>
        <label>向上<input v-model.number="mouseEvent.mouseUp" class="settings-field" type="number" min="0" max="255"></label>
        <label>向下<input v-model.number="mouseEvent.mouseDown" class="settings-field" type="number" min="0" max="255"></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>滚轮</legend>
      <div class="fields">
        <label>向上滚动<input v-model.number="mouseEvent.rollUp" class="settings-field" type="number" min="0" max="255"></label>
        <label>向下滚动<input v-model.number="mouseEvent.rollDown" class="settings-field" type="number" min="0" max="255"></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>点击</legend>
      <div class="choices">
        <button v-for="item in mouseArray" :key="item.eventId" class="settings-button" type="button"
          :aria-pressed="item.isSelect" @click="item.isSelect = !item.isSelect">{{ item.eventName }}</button>
      </div>
    </fieldset>
    <div class="actions"><button type="submit" class="settings-button is-primary">确认</button></div>
  </form>
</template>

<style lang="scss" scoped>
#mouse-func-content { width:min(500px,90%); padding:16px; }
h3 { margin-bottom:10px; font-size:15px; }
fieldset { min-width:0; margin:0 0 10px; padding:0; border:0; }
legend { margin-bottom:5px; font-weight:650; font-size:13px; color:var(--settings-ink); }
.fields,.choices { display:grid; gap:7px; }
.fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
.choices { grid-template-columns:repeat(3,minmax(0,1fr)); }
label { display:grid; gap:3px; font-size:12px; color:var(--settings-muted); }
.choices button[aria-pressed=true] { color:var(--settings-accent); background:var(--settings-selected); border-color:var(--settings-input-line); }
.actions { display:flex; justify-content:flex-end; }
</style>
