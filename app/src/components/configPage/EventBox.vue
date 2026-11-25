<script setup lang="ts">
import { computed } from 'vue'
import { useConfigStore } from '../../stores/configStore'

const configStore = useConfigStore()
const win = window as any

const events = ['按下', '抬起', '左旋', '右旋', '按下左旋', '按下右旋']
const visibleEvents = computed(() => configStore.configIndex < 8 ? events.slice(0, 2) : events)
const closeWindow = () => {
  // 发送到主页面进行同步
  for (let i = 0; i < 6; i++) {
    let tempObj: object = {}
    tempObj['curEvent'] = i
    tempObj['keyConfig'] = JSON.stringify(configStore.keyConfig[i])
    win.myApi.setConfigStore(tempObj)
    win.myApi.closeWindow()
  }
}
</script>

<template>
  <div id="event-box-content">
    <div id="event-box">
      <button v-for="(label, index) in visibleEvents" :key="label" type="button" class="settings-button"
        :aria-pressed="configStore.curEvent === index" @click="configStore.setCurEvent(index)">{{ label }}</button>
    </div>
    <button id="commit-box" class="settings-button is-primary" type="button" @click="closeWindow">确认</button>
  </div>
</template>

<style lang="scss" scoped>
#event-box-content { display:grid; gap:13px; }
#event-box { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
#event-box button[aria-pressed="true"] { background:var(--settings-selected); color:var(--settings-accent); border-color:var(--settings-input-line); }
#commit-box { justify-self:end; min-width:82px; }
</style>
