<script setup lang="ts">
defineProps<{ values: number[]; compact?: boolean }>()

const metrics = [
  { label: 'CPU', detail: '处理器使用率', color: '#58e0c3' },
  { label: '内存', detail: '物理内存占用率', color: '#80bbff' },
  { label: '系统盘', detail: '容量占用率', color: '#e8bd80' }
]

function hasReading(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
}
</script>

<template>
  <section class="performance-display" :class="{ compact }" aria-label="电脑性能">
    <div v-if="compact" class="monitor-heading">
      <strong>电脑性能</strong>
      <span class="sample-status" :data-ready="values.some(hasReading)">
        {{ values.some(hasReading) ? '实时' : '采样中' }}
      </span>
    </div>
    <div class="metrics">
      <div v-for="(metric, index) in metrics" :key="metric.label" class="metric" :style="{ '--accent': metric.color }">
        <div class="metric-heading">
          <span class="metric-label">{{ metric.label }}</span>
          <span v-if="!compact" class="metric-detail">{{ metric.detail }}</span>
        </div>
        <span class="metric-value">
          {{ hasReading(values[index]) ? values[index] : '—' }}<small v-if="hasReading(values[index])">%</small>
        </span>
        <progress v-if="hasReading(values[index])" :value="values[index]" max="100" :aria-label="metric.label" />
        <span v-else class="empty-track" aria-hidden="true"></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.performance-display {
  box-sizing: border-box;
  width: 100%;
  color: #f0f6fb;
  font-variant-numeric: tabular-nums;
  text-align: left;
}
.monitor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 11px;
}
.sample-status {
  color: #b5c5d4;
  font-size: 9px;
  font-weight: 500;
}
.sample-status[data-ready="true"] { color: #79e5ce; }
.metrics {
  display: grid;
  gap: 8px;
}
.metric {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px 8px;
  align-items: center;
  padding: 10px 13px 12px;
  border: 1px solid #33475d;
  border-radius: 9px;
  background: #192c40;
}
.metric-heading { display: flex; flex-direction: column; gap: 3px; }
.metric-label { font-size: 14px; font-weight: 650; }
.metric-detail { color: #bacbdd; font-size: 11px; }
.metric-value { color: var(--accent); font-size: 22px; line-height: 1; font-weight: 650; }
.metric-value small { margin-left: 1px; font-size: .64em; }
progress, .empty-track {
  grid-column: 1 / -1;
  box-sizing: border-box;
  width: 100%;
  height: 5px;
  border: 0;
  border-radius: 99px;
  overflow: hidden;
  background: #354a60;
  appearance: none;
}
progress::-webkit-progress-bar { background: #354a60; }
progress::-webkit-progress-value { border-radius: 99px; background: var(--accent); }
@media (prefers-reduced-motion: no-preference) {
  progress::-webkit-progress-value { transition: width 220ms ease-out; }
}
.compact {
  height: 100%;
  padding: 8px 10px;
  background: #102032;
}
.compact .metrics { gap: 4px; }
.compact .metric {
  grid-template-columns: 40px minmax(0, 1fr) 34px;
  column-gap: 6px;
  min-height: 19px;
  padding: 0 5px;
  border: none;
  border-radius: 4px;
}
.compact .metric-label { font-size: 9px; }
.compact .metric-value { grid-column: 3; grid-row: 1; font-size: 11px; text-align: right; }
.compact progress, .compact .empty-track { grid-column: 2; grid-row: 1; height: 4px; }
</style>
