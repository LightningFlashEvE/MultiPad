<script setup lang="ts">
import WindowTitle from '../components/tools/WindowTitle.vue'
import PopBox from '../components/tools/PopBox.vue'
import ConfigData from '../components/configPage/ConfigData.vue'
import EventBox from '../components/configPage/EventBox.vue'
import FuncBox from '../components/configPage/FuncBox.vue'
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useConfigStore } from '../stores/configStore'
import { useRouter } from 'vue-router'

const win = window as any
const router = useRouter()
const configStore = useConfigStore()
const funcShow = ref<boolean>(false)
const popBoxRef = ref<HTMLElement | null>(null)

onMounted(() => {
  win.myApi.storeChangeListen((objData: object) => {
    console.info('keyConfigPage listening')
    const keys = Object.keys(objData)
    // 复制单键配置
    if (keys[0] == 'keyConfig') {
      let tempArr = JSON.parse(objData[keys[0]])
      for (let i = 0; i < 6; i++) {
        configStore.setCurEvent(i)
        let temp = {
          userKey: tempArr[i].userKey,
          genKey: tempArr[i].genKey
        }
        configStore.setKeyConfig(JSON.stringify(temp))
      }
      configStore.setCurEvent(0)
      return
    }
    for (let key of keys) {
      // 设置对应 store 的
      configStore[`set${key.replace(key.charAt(0), key.charAt(0).toUpperCase())}`](objData[key])
    }
  })
  // 获取 配置的索引
  win.myApi.setConfigStore({
    get: 'configIndex'
  })
  win.myApi.setConfigStore({
    get: 'keyConfig'
  })
})

const closeFuncBox = () => {
  configStore.setFuncShow(false)
}
watch(
  () => configStore.funcShow,
  () => {
    if (configStore.funcShow == true) {
      funcShow.value = true
    } else {
      funcShow.value = false
      router.push(`/config`)
    }
  }
)

</script>

<template>
  <PopBox ref="popBoxRef" />
  <div class="settings-window">
    <WindowTitle>
      <template #title>按键配置</template>
    </WindowTitle>
    <div id="key-config-content" class="settings-scroll">
      <div class="key-config-main">
        <section class="key-section mapping">
          <h2>当前映射</h2>
          <ConfigData />
        </section>
        <section class="key-section">
          <h2>触发方式</h2>
          <EventBox />
        </section>
      </div>
      <section class="key-section function-section">
        <h2>功能类型</h2>
        <FuncBox />
      </section>
    </div>
    <div id="func-position" v-if="funcShow" @click.stop="closeFuncBox">
      <router-view class="function-editor" @click.stop=""></router-view>
    </div>
  </div>
</template>

<style lang="scss" scoped>
#key-config-content {
  width:100%;
  flex:1;
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(230px,.86fr);
  gap:14px;
  padding:16px;
  background:var(--settings-canvas);
}
.key-config-main { display:grid; grid-template-rows:minmax(115px,.75fr) auto; gap:14px; min-width:0; }
.key-section { min-width:0; padding:14px; border-radius:10px; background:var(--settings-surface); }
.key-section h2 { margin:0 0 10px; font-size:14px; font-weight:650; color:var(--settings-ink); }
.mapping { display:flex; flex-direction:column; min-height:0; }
.function-section { display:flex; flex-direction:column; min-height:0; }
#func-position { position:absolute; inset:0; background:#1c2e2873; z-index:88; }
#func-position :deep(.function-editor) {
  position:absolute;
  top:50%;
  left:50%;
  transform:translate(-50%,-50%);
  max-width:calc(100% - 36px);
  max-height:calc(100% - 36px);
  overflow:auto;
  border:1px solid var(--settings-line);
  border-radius:12px;
  background:var(--settings-surface);
  box-shadow:0 12px 34px #15272040;
  color:var(--settings-ink);
}
#func-position :deep(.function-editor #commit-box),
#func-position :deep(#mouse-func-content .div9),
#func-position :deep(#comp-delay-content .div4) {
  border:0;
  border-radius:8px;
  background:var(--settings-accent);
  color:white;
  font-size:14px;
}
#func-position :deep(#menu-func-content > div:not(#commit-box)),
#func-position :deep(#mouse-func-content > div:not(.div9)),
#func-position :deep(#comp-special),
#func-position :deep(#delay-config-box) {
  border-radius:8px;
  background:var(--settings-group);
  color:var(--settings-ink);
  box-shadow:none;
}
#func-position :deep(#mouse-func-content input:not(.div7 input)) { color:var(--settings-ink); font-size:20px; }
#func-position :deep(#mouse-func-content .div7) { border-color:var(--settings-input-line); }
#func-position :deep(#mouse-func-content .div7 span) { background:var(--settings-accent); }
#func-position :deep(#mouse-func-content) { height:min(465px, calc(100% - 36px)); }
#func-position :deep(#menu-func-content .isSelect),
#func-position :deep(#mouse-func-content .isSelect) {
  background:var(--settings-selected) !important;
  color:var(--settings-accent) !important;
  border-color:var(--settings-input-line) !important;
}
#func-position :deep(#media-key-content li) {
  min-height:56px;
  height:auto;
  background:var(--settings-canvas);
  border-radius:8px;
  font-size:14px;
}
#func-position :deep(#pre-shortcuts-content #shortcuts-box) {
  width:min(590px, 94%);
  height:min(480px, 76vh);
  border-radius:10px;
}
@media(max-width:620px) {
  #key-config-content { grid-template-columns:1fr; gap:10px; padding:12px; }
  .key-config-main { gap:10px; }
}
</style>
