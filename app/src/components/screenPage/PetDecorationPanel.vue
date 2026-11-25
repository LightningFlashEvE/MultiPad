<script setup lang="ts">
import { computed, ref } from 'vue'
import { petFurniture, petLampGeneration, petLampIsLit, petWarehouseGeneration,
  type PetFurnitureId, type PetPosition, type PetWarehouse } from '../../utils/petCatalog'
import PetDisplay from './PetDisplay.vue'
import type { PetState } from './petDisplay'

const props = defineProps<{ state: PetState; connected: boolean; generation: number; busy: boolean; warehouse?: PetWarehouse }>()
const emit = defineEmits<{ enter: []; move: [id: PetFurnitureId, position: PetPosition]; rest: []; inspect: []; lamp: [installed: boolean]; toggleLight: [] }>()
const selected = ref<PetFurnitureId>('hutch')
const owned = computed(() => petFurniture.filter(item => !props.warehouse || Boolean(props.warehouse.owned & item.ownedFlag)))
const item = computed(() => owned.value.find(item => item.id === selected.value) ?? owned.value[0])
const supportedGeneration = computed(() => props.connected ? props.generation : petWarehouseGeneration)
const installed = computed(() => item.value?.id !== 'lamp' || props.state.pendantLamp)
const lampLit = computed(() => props.state.pendantLampLit ?? petLampIsLit(props.state.hour))
const canMove = computed(() => item.value && supportedGeneration.value >= item.value.generation && props.state.scene === 1 && !props.busy)
const position = computed(() => (item.value?.id === 'hutch' ? props.state.hutchPosition :
  item.value?.id === 'table' ? props.state.tablePosition : props.state.lampPosition) ?? item.value?.position)
function resetPosition() {
  if (item.value && canMove.value && installed.value) {
    emit('move', item.value.id, item.value.position)
  }
}
</script>

<template>
  <div class="decoration-panel">
    <aside aria-label="拥有的家具">
      <h3>我的家具</h3>
      <button v-for="furniture in owned" :key="furniture.id" type="button" class="owned-item"
        :aria-pressed="item?.id === furniture.id" @click="selected = furniture.id">
        {{ furniture.label }}
        <small>{{ furniture.id === 'lamp' && !state.pendantLamp ? '已收起' : '已摆放' }}</small>
      </button>
    </aside>
    <section class="room">
      <PetDisplay :state="state" :connected="connected && state.active" editable-decoration
        :decoration-generation="supportedGeneration" :decoration-busy="busy" :selected-furniture="item?.id"
        @move-furniture="(id, p) => emit('move', id, p)" @select-furniture="id => selected = id" />
      <template v-if="item">
      <h3>{{ item.label }}</h3>
      <template v-if="state.scene !== 1">
        <p>进入宝宝房摆放家具。</p>
        <button type="button" :disabled="busy || supportedGeneration < 2" @click="emit('enter')">进入宝宝房</button>
      </template>
      <template v-else>
        <p v-if="item.id === 'lamp'">19:00 自动开灯，06:00 自动关灯。<template v-if="state.pendantLamp">
          当前{{ lampLit ? '已点亮' : '关闭' }}。</template></p>
        <p v-if="installed && supportedGeneration >= item.generation">直接拖动{{ item.label }}，松开保存。也可用方向键微调。</p>
        <p v-else-if="supportedGeneration < item.generation">升级键盘固件后可移动{{ item.label }}。</p>
        <div class="actions">
          <button v-if="installed" type="button"
            :disabled="!canMove || (position?.x === item.position.x && position?.y === item.position.y)" @click="resetPosition">恢复默认</button>
          <button v-if="item.id === 'hutch'" type="button" :disabled="busy || !!state.fruit || supportedGeneration < 4"
            @click="emit('rest')">去兔窝小憩</button>
          <button v-if="item.id === 'table'" type="button" :disabled="busy || !!state.fruit || !!state.activeToy || supportedGeneration < 7"
            @click="emit('inspect')">去桌边看看</button>
          <button v-if="item.id === 'lamp'" type="button" :disabled="busy || supportedGeneration < petLampGeneration"
            @click="emit('lamp', !state.pendantLamp)">{{ state.pendantLamp ? '收起挂灯' : '安装挂灯' }}</button>
          <button v-if="item.id === 'lamp' && state.pendantLamp && (!connected || state.pendantLampManual)"
            type="button" :disabled="busy" @click="emit('toggleLight')">{{ lampLit ? '手动关灯' : '手动开灯' }}</button>
        </div>
      </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.decoration-panel { display:grid; grid-template-columns:minmax(123px,.45fr) minmax(0,1.55fr); align-items:start; gap:12px; }
aside { display:grid; gap:5px; padding:10px; background:var(--settings-surface); border-radius:10px; }
.room :deep(.pet-scene) { border-radius:9px; }
h3 { margin:0; font-size:15px; }
.room h3 { margin-top:10px; }
.room p { margin:5px 0 8px; font-size:12px; color:#49615f; }
button { padding:6px 8px; background:var(--settings-group); border:1px solid transparent; border-radius:var(--settings-radius); color:var(--settings-ink); font:inherit; font-size:13px; }
button:enabled { cursor:pointer; }
button:hover:enabled { background:var(--settings-selected); }
button:disabled { opacity:.55; }
button[aria-pressed=true] { background:var(--settings-selected); color:var(--settings-accent); border-color:var(--settings-input-line); }
.owned-item { display:flex; justify-content:space-between; align-items:center; gap:4px; text-align:left; }
small { color:#49615f; font-size:11px; }
.actions { display:flex; flex-wrap:wrap; gap:6px; }
@media(max-width:460px) { .decoration-panel { grid-template-columns:1fr; } aside { display:flex; flex-wrap:wrap; align-items:center; } }
</style>
