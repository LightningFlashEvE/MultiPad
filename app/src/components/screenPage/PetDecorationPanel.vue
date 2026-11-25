<script setup lang="ts">
import { computed, ref } from 'vue'
import { furniturePositionValid, petFurniture, petLampGeneration, petLampIsLit, petWarehouseGeneration,
  type PetFurnitureId, type PetPosition } from '../../utils/petCatalog'
import PetDisplay from './PetDisplay.vue'
import type { PetState } from './petDisplay'

const props = defineProps<{ state: PetState; connected: boolean; generation: number; busy: boolean }>()
const emit = defineEmits<{ enter: []; move: [id: PetFurnitureId, position: PetPosition]; rest: []; inspect: []; lamp: [installed: boolean] }>()
const selected = ref<PetFurnitureId>('hutch')
const item = computed(() => petFurniture.find(item => item.id === selected.value) ?? petFurniture[0])
const supportedGeneration = computed(() => props.connected ? props.generation : petWarehouseGeneration)
const installed = computed(() => selected.value !== 'lamp' || props.state.pendantLamp)
const canMove = computed(() => supportedGeneration.value >= item.value.generation && props.state.scene === 1 && !props.busy)
const position = computed(() => (selected.value === 'hutch' ? props.state.hutchPosition :
  selected.value === 'table' ? props.state.tablePosition : props.state.lampPosition) ?? item.value.position)
function resetPosition() {
  if (canMove.value && installed.value && furniturePositionValid(item.value, item.value.position.x, item.value.position.y)) {
    emit('move', item.value.id, item.value.position)
  }
}
</script>

<template>
  <div class="decoration-panel">
    <aside aria-label="拥有的家具">
      <h3>我的家具</h3>
      <button v-for="furniture in petFurniture" :key="furniture.id" type="button" class="owned-item"
        :aria-pressed="selected === furniture.id" @click="selected = furniture.id">
        {{ furniture.label }}
        <small>{{ furniture.id === 'lamp' && !state.pendantLamp ? '已收起' : '已摆放' }}</small>
      </button>
    </aside>
    <section class="room">
      <PetDisplay :state="state" :connected="connected && state.active" editable-decoration
        :decoration-generation="supportedGeneration" :decoration-busy="busy" :selected-furniture="selected"
        @move-furniture="(id, p) => emit('move', id, p)" @select-furniture="id => selected = id" />
      <h3>{{ item.label }}</h3>
      <template v-if="state.scene !== 1">
        <p>进入宝宝房摆放家具。</p>
        <button type="button" :disabled="busy || supportedGeneration < 2" @click="emit('enter')">进入宝宝房</button>
      </template>
      <template v-else>
        <p v-if="selected === 'lamp'">19:00–次日 06:00 自动照亮房间。<template v-if="state.pendantLamp">
          当前{{ petLampIsLit(state.hour) ? '已点亮' : '关闭' }}。</template></p>
        <p v-if="installed && supportedGeneration >= item.generation">直接拖动{{ item.label }}，松开保存。也可用方向键微调。</p>
        <p v-else-if="supportedGeneration < item.generation">升级键盘固件后可移动{{ item.label }}。</p>
        <div class="actions">
          <button v-if="installed" type="button"
            :disabled="!canMove || (position.x === item.position.x && position.y === item.position.y)" @click="resetPosition">恢复默认</button>
          <button v-if="selected === 'hutch'" type="button" :disabled="busy || !!state.fruit || supportedGeneration < 4"
            @click="emit('rest')">去兔窝小憩</button>
          <button v-if="selected === 'table'" type="button" :disabled="busy || !!state.fruit || !!state.activeToy || supportedGeneration < 7"
            @click="emit('inspect')">去桌边看看</button>
          <button v-if="selected === 'lamp'" type="button" :disabled="busy || supportedGeneration < petLampGeneration"
            @click="emit('lamp', !state.pendantLamp)">{{ state.pendantLamp ? '收起挂灯' : '安装挂灯' }}</button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.decoration-panel { display:grid; grid-template-columns:minmax(112px, .42fr) minmax(0, 1.58fr); align-items:start; gap:16px; }
aside { display:grid; gap:6px; }
h3 { margin:0; font-size:15px; }
.room h3 { margin-top:10px; }
.room p { margin:5px 0 8px; font-size:12px; color:#49615f; }
button { padding:6px 8px; background:#fff; border:1px solid #bbc9c6; border-radius:6px; color:#304647; font:inherit; font-size:13px; }
button:enabled { cursor:pointer; }
button:disabled { opacity:.55; }
button[aria-pressed=true] { background:#deede7; border-color:#568475; }
.owned-item { display:flex; justify-content:space-between; align-items:center; gap:4px; text-align:left; }
small { color:#49615f; font-size:11px; }
.actions { display:flex; flex-wrap:wrap; gap:6px; }
@media(max-width:460px) { .decoration-panel { grid-template-columns:1fr; } aside { display:flex; flex-wrap:wrap; align-items:center; } }
</style>
