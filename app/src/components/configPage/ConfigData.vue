<script setup lang="ts">
import { computed } from 'vue'
import { useConfigStore } from '../../stores/configStore'

const configStore = useConfigStore()
const configStr = computed(() => configStore.keyConfig[configStore.curEvent]?.userKey)
</script>

<template>
  <div id="config-data-content" class="settings-scroll">
    <div v-if="configStr" v-html="configStr"></div>
    <p v-else class="empty">此触发方式尚未配置。</p>
  </div>
</template>

<style lang="scss" scoped>
#config-data-content { flex:1; display:grid; align-content:start; min-height:56px; padding:12px; border-radius:7px; background:var(--settings-canvas); color:var(--settings-ink); font-size:15px; overflow-wrap:anywhere; }
.empty { color:var(--settings-muted); font-size:13px; }
</style>
