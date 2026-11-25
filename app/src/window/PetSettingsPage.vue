<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import WindowTitle from '../components/tools/WindowTitle.vue'
import PetDisplay from '../components/screenPage/PetDisplay.vue'
import PetStatSettings from '../components/screenPage/PetStatSettings.vue'
import PetAiSettings from '../components/screenPage/PetAiSettings.vue'
import PetItemsPanel from '../components/screenPage/PetItemsPanel.vue'
import PetDecorationPanel from '../components/screenPage/PetDecorationPanel.vue'
import PetShopPanel from '../components/screenPage/PetShopPanel.vue'
import { petParameters, petSeasons, petStats, petValue, type PetParameter } from '../components/screenPage/petDisplay'
import { petActions, petActionLabels, petLampCommand, petRoomItems, petSceneLabels, petScenes, type PetFurnitureId, type PetPosition } from '../utils/petCatalog'
import type { PetSettingsAction, PetSettingsSnapshot, PetSettingsTab } from '../utils/petSettings'

const api = (window as any).myApi
const settings = shallowRef<PetSettingsSnapshot>()
const pageBody = ref<HTMLElement>()
const petTab = ref<PetSettingsTab>('scene')
const selectedItem = ref(1)
const tabs = [['scene','场景与作息'],['stats','属性数值'],['items','道具'],['decor','装修'],['shop','商店'],['ai','AI 控制']] as const
const screenLabels = ['彩屏', '左侧 OLED', '右侧 OLED']
const petScreen = computed(() => settings.value?.view.screen ?? 0)
const title = computed(() => petScreen.value === 0 ? '宠物设置' : screenLabels[petScreen.value] + ' · 宠物参数')
const petState = computed(() => settings.value!.state)
const currentToy = computed(() => petRoomItems.find(item => item.wireId === petState.value.activeToy))
const clockText = computed(() => [petState.value.hour, petState.value.minute ?? 0].map(n => String(n).padStart(2, '0')).join(':'))
let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = api.onPetSettingsSnapshot((snapshot: PetSettingsSnapshot) => {
    if (settings.value?.view.revision !== snapshot.view.revision) {
      petTab.value = snapshot.view.tab
      selectedItem.value = snapshot.view.selectedItem
      if (pageBody.value) pageBody.value.scrollTop = 0
    }
    settings.value = snapshot
  })
})
onUnmounted(() => unsubscribe?.())
watch(petTab, () => { if (pageBody.value) pageBody.value.scrollTop = 0 })
watch(title, value => { document.title = value }, { immediate: true })

const run = (action: PetSettingsAction): Promise<boolean> => api.runPetSettingsAction(action).catch(() => false)
const interactWithPet = (command: number, value: number) => run(['interact', command, value])
function setScene(command: 4 | 5 | 6, event: Event) {
  const select = event.target as HTMLSelectElement
  const value = Number(select.value)
  if (command === 6 && settings.value?.connected) select.value = String(petState.value.scene)
  void run(['scene', command, value])
}
function setFollowClock(event: Event) {
  const input = event.target as HTMLInputElement
  const checked = input.checked
  if (settings.value?.connected) input.checked = settings.value.followClock
  void run(['follow-clock', checked])
}
function setPetParameter(row: number, event: Event) {
  if (petScreen.value === 0) return
  void run(['parameter', petScreen.value, row, (event.target as HTMLSelectElement).value as PetParameter])
}
const selectTab = (tab: PetSettingsTab) => { petTab.value = tab; void run(['clear-notice']) }
const selectItem = (id: number) => { selectedItem.value = id; void run(['clear-notice']) }
const moveFurniture = (id: PetFurnitureId, point: PetPosition) => run(['move', id, point])
const togglePetLamp = () => run(['toggle-lamp'])
const buySnack = (id: number) => run(['buy', id])
const useItem = (id: number) => run(['use', id])
</script>

<template>
  <div class="settings-window">
    <WindowTitle>
      <template #title>{{ title }}</template>
    </WindowTitle>
    <nav v-if="settings && petScreen === 0" class="pet-tabs" aria-label="宠物设置">
      <button v-for="tab in tabs" :key="tab[0]" type="button" :aria-pressed="petTab === tab[0]"
        @click="selectTab(tab[0])">{{ tab[1] }}</button>
    </nav>
    <main ref="pageBody" class="pet-settings-body settings-scroll">
      <div v-if="settings" class="pet-settings-content" :class="{ parameters: petScreen > 0 }">
        <p v-if="!settings.petMode" class="mode-note" role="status">切回养宠模式后即可调整宠物。</p>
        <template v-if="petScreen === 0">
          <PetAiSettings v-if="petTab === 'ai'" :device-ready="settings.connected && petState.active" />
          <PetStatSettings v-else-if="petTab === 'stats'" :key="settings.connected ? settings.session : 'preview'"
            :stats="petState.stats" :connected="settings.connected" :supported="!settings.connected || settings.generation >= 10"
            :busy="settings.busy"
            :save="interactWithPet" />
          <PetDecorationPanel v-else-if="petTab === 'decor'" :state="petState" :connected="settings.connected" :generation="settings.generation" :warehouse="settings.warehouse"
            :busy="settings.busy" @enter="interactWithPet(6, 1)"
            @lamp="installed => interactWithPet(petLampCommand, Number(installed))"
            @toggle-light="togglePetLamp"
            @move="moveFurniture" @rest="interactWithPet(15, 0)" @inspect="interactWithPet(3, 14)" />
          <PetShopPanel v-else-if="petTab === 'shop'" :warehouse="settings.warehouse" :linked="settings.connected"
            :busy="settings.busy" @buy="buySnack" />
          <PetItemsPanel v-else-if="petTab === 'items'" :selected="selectedItem" :bindings="settings.bindings" :generation="settings.generation"
            :connected="settings.connected" :busy="settings.busy" :occupied="!!currentToy" :scene="petState.scene"
            :deployed-toys="petState.deployedToys" :toy-drop="petState.toyDrop" :food-count="petState.foods?.length ?? 0"
            :full="petState.stats?.satiety === 100" :warehouse="settings.warehouse" @play="id => interactWithPet(11, id)"
            @select="selectItem"
            @bind="(key, id) => interactWithPet(8, (key << 4) | id)" @use="useItem" />
          <div v-else class="scene-settings">
            <section>
              <PetDisplay :state="petState" :connected="settings.connected && petState.active" />
              <dl class="pet-stats" aria-label="宠物属性，满值一百">
                <div v-for="stat in petStats" :key="stat.id">
                  <dt>{{ stat.label }}</dt><dd>{{ petValue(stat.id, petState) }}</dd>
                </div>
              </dl>
              <div class="pet-fields" role="group" aria-label="宠物互动">
                <button type="button" class="settings-button" :disabled="settings.busy || !!petState.fruit || (settings.connected && settings.generation < 3 && !!currentToy)"
                  @click="interactWithPet(3, settings.sleeping ? 0 : 2)">{{ settings.sleeping ? '叫醒' : '睡觉' }}</button>
                <button v-for="action in (['trip_angry', 'gaze_owner', 'stand_watch', 'binky', 'groom_fur', 'groom_ear'] as const)" :key="action"
                  type="button" class="settings-button" :disabled="settings.legacy || settings.busy || !!currentToy || (settings.connected && ((action === 'stand_watch' && settings.generation < 7) || (action === 'binky' && settings.generation < 8) || ((action === 'groom_fur' || action === 'groom_ear') && settings.generation < 9)))"
                  @click="interactWithPet(3, petActions.indexOf(action))">{{ petActionLabels[action] }}</button>
              </div>
            </section>
            <section class="scene-controls">
              <label>宠物场景
                <select class="settings-field" :value="petState.scene" :disabled="settings.busy || settings.legacy" @change="setScene(6, $event)">
                  <option v-for="(scene, index) in petScenes" :key="scene" :value="index">{{ petSceneLabels[scene] }}</option>
                </select>
              </label>
              <label>场景季节
                <select class="settings-field" :value="petState.season" :disabled="settings.busy" @change="setScene(5, $event)">
                  <option v-for="(name, index) in petSeasons" :key="name" :value="index">{{ name }}</option>
                </select>
              </label>
              <label class="follow-clock"><input type="checkbox" :checked="settings.followClock"
                :disabled="settings.busy || (settings.connected && settings.generation < 3)" @change="setFollowClock">跟随现实时间</label>
              <label v-if="!settings.followClock">场景时间
                <select class="settings-field" :value="petState.hour" :disabled="settings.busy" @change="setScene(4, $event)">
                  <option v-for="n in 24" :key="n" :value="n - 1">{{ String(n - 1).padStart(2, '0') }}:00</option>
                </select>
              </label>
              <p v-else class="clock-readout">场景时间 <time>{{ clockText }}</time></p>
              <p class="knob-hint">小旋钮 1 调时间，小旋钮 2 调季节。<template v-if="!settings.connected || petState.pendantLampManual">按一下小旋钮 2 开关挂灯。</template><template v-if="!settings.connected || settings.generation >= 3">按住小旋钮 2 转动可切换背景。</template></p>
              <p v-if="settings.connected && settings.generation < 3">升级键盘固件即可启用跟随现实时间。</p>
              <p v-else-if="settings.followClock">连接软件时校准为电脑本地时间。</p>
            </section>
          </div>
          <p v-if="petTab !== 'ai' && currentToy" class="pet-note" role="status">{{ petState.toyPhase === 1 ? '正在走向' : '正在使用' }}{{ currentToy.label }}</p>
          <p v-if="settings.status" class="pet-note" role="status">{{ settings.status }}</p>
          <p v-else-if="petTab === 'scene' && settings.legacy" class="pet-note">升级键盘固件即可启用新动作、场景玩具和宠物属性。</p>
          <p v-else-if="petTab === 'scene' && !settings.connected" class="pet-note">本机预览 · 连接后显示键盘上的宠物和属性。</p>
        </template>
        <template v-else>
          <img class="oled-sample" v-if="settings.previews[petScreen - 1]" :src="settings.previews[petScreen - 1]" alt="双参数小屏预览">
          <div class="param-fields">
            <label v-for="row in 2" :key="row">{{ row === 1 ? '第一行' : '第二行' }}
              <select class="settings-field" :value="settings.parameters[petScreen - 1][row - 1]" :disabled="settings.busy" @change="setPetParameter(row - 1, $event)">
                <option v-for="option in petParameters" :key="option.id" :value="option.id"
                  :disabled="settings.legacy && petStats.some(stat => stat.id === option.id)">{{ option.label }}</option>
              </select>
            </label>
          </div>
          <p v-if="settings.legacy">升级键盘固件即可显示宠物属性。</p>
        </template>

      </div>
      <p v-else role="status">正在读取宠物设置…</p>
    </main>
  </div>
</template>
<style scoped>
.pet-tabs { display:flex; gap:6px; padding:10px clamp(18px,3vw,28px); border-bottom:1px solid var(--settings-line); }
.pet-tabs button { flex:none; min-height:36px; padding:6px 10px; border:0; border-radius:7px; color:var(--settings-muted); background:transparent; font:600 14px var(--settings-font); cursor:pointer; }
.pet-tabs button:hover { background:var(--settings-canvas); color:var(--settings-ink); }
.pet-tabs button[aria-pressed=true] { color:var(--settings-accent); background:var(--settings-selected); }
.pet-settings-body { flex:1; padding:clamp(18px,3vw,28px); background:var(--settings-canvas); }
.pet-settings-content { max-width:1140px; margin-inline:auto; }
.mode-note { margin-bottom:12px; color:var(--settings-muted); }
.pet-settings-content.parameters { max-width:480px; padding:24px; background:var(--settings-surface); border-radius:10px; }
.scene-settings { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(220px,1fr); gap:20px; }
.scene-settings :deep(.pet-scene) { border-radius:9px; }
.scene-controls, .param-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; align-content:start; }
.scene-controls { padding:12px; border-radius:10px; background:var(--settings-surface); }
.scene-controls label, .param-fields label { display:grid; gap:4px; font-size:13px; font-weight:600; }
.scene-controls .follow-clock { display:flex; align-items:center; gap:7px; grid-column:1/-1; margin-top:2px; }
.scene-controls input[type=checkbox] { accent-color:var(--settings-accent); }
.scene-controls .clock-readout,.scene-controls p { grid-column:1/-1; color:var(--settings-muted); font-size:12px; }
.scene-controls .clock-readout { display:flex; justify-content:space-between; padding:6px 8px; background:var(--settings-group); border-radius:6px; }
.scene-controls time { font-variant-numeric:tabular-nums; }
.oled-sample { width:216px; height:120px; display:block; margin:4px auto 14px; border-radius:7px; image-rendering:pixelated; background:#000; }
.pet-fields { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.pet-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; margin-top:9px; padding:9px 10px; border-radius:8px; background:var(--settings-surface); }
.pet-stats dt { color:var(--settings-muted); font-size:12px; }
.pet-stats dd { margin-top:2px; font-size:17px; font-weight:650; font-variant-numeric:tabular-nums; }
.pet-note { margin-top:10px; color:var(--settings-muted); font-size:12px; }
@media(max-width:650px) { .scene-settings { grid-template-columns:1fr; } }
</style>
