<script setup lang="ts">
import { reactive } from 'vue'
import { isStatValue, petStats } from '../../utils/petCatalog'
import type { PetState } from './petDisplay'

const props = defineProps<{
  stats: PetState['stats']
  connected: boolean
  supported: boolean
  busy: boolean
  save: (command: number, value: number) => Promise<boolean | undefined>
}>()
type Stat = typeof petStats[number]
const drafts = reactive<Partial<Record<Stat['id'], string>>>({})
function valid(stat: Stat) {
  const draft = drafts[stat.id]
  return draft !== undefined && draft.trim() !== '' && isStatValue(Number(draft))
}
async function apply(stat: Stat) {
  if (props.busy || !props.supported || !valid(stat)) return
  const saved = await props.save(stat.command, Number(drafts[stat.id]))
  if (saved) delete drafts[stat.id]
}
</script>

<template>
  <section class="stat-editor">
    <p>{{ !supported ? '升级键盘固件后即可手动调整属性。' : connected ? '输入 0–100 的整数。保存后写入键盘，断电也会保留。' : '输入 0–100 的整数。当前调整仅用于本机预览。' }}</p>
    <div v-for="stat in petStats" :key="stat.id" class="stat-row">
      <div>
        <label :for="'edit-' + stat.id">{{ stat.label }}</label>
        <span class="current">{{ stats?.[stat.id] ?? '—' }} / 100</span>
        <progress :value="stats?.[stat.id] ?? 0" max="100" :aria-label="stat.label + '当前值'" />
      </div>
      <input :id="'edit-' + stat.id" class="settings-field" type="number" inputmode="numeric" min="0" max="100" step="1"
        :value="drafts[stat.id] ?? stats?.[stat.id]" :disabled="busy || !supported || !stats"
        :aria-invalid="drafts[stat.id] !== undefined && !valid(stat)"
        @input="drafts[stat.id] = ($event.target as HTMLInputElement).value"
        @keydown.enter.prevent="apply(stat)">
      <button type="button" class="settings-button" :aria-label="'保存' + stat.label"
        :disabled="busy || !supported || !stats || !valid(stat) || Number(drafts[stat.id]) === stats[stat.id]"
        @click="apply(stat)">保存</button>
    </div>
  </section>
</template>

<style scoped>
.stat-editor { padding:12px 14px 5px; background:var(--settings-surface); border-radius:10px; }
.stat-editor p { margin:0 0 10px; color:var(--settings-muted); font-size:13px; }
.stat-row { display:grid; grid-template-columns:minmax(0,1fr) 64px auto; align-items:center; gap:12px; padding:11px 0; border-top:1px solid var(--settings-line); }
.stat-row label { font-weight: 600; }
.current { margin-left: 10px; color: #526660; font-size: 12px; font-variant-numeric: tabular-nums; }
.stat-row progress { display: block; width: 100%; height: 6px; margin-top: 6px; accent-color: #39796b; }
.stat-row input[aria-invalid=true] { border-color: #a34432; }
</style>
