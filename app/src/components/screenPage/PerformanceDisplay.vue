<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { drawPerformanceLcd, hasPerformanceReading, height, width } from './performanceLcd'

const props = defineProps<{ values: number[] }>()
const canvas = ref<HTMLCanvasElement>()
const description = computed(() => ['处理器', '内存', '系统盘'].map((label, index) => {
  const value = props.values[index]
  return `${label} ${hasPerformanceReading(value) ? `${value}%` : '暂无读数'}`
}).join('，'))

watchEffect(() => {
  const ctx = canvas.value?.getContext('2d')
  if (ctx) drawPerformanceLcd(ctx, props.values)
})
</script>

<template>
  <canvas ref="canvas" class="performance-display" :width="width" :height="height"
    role="img" :aria-label="description" />
</template>

<style scoped>
.performance-display {
  display: block;
  width: 100%;
  height: auto;
  image-rendering: pixelated;
}
</style>
