<script setup lang="ts">
import { petFruitIds, petFruitLabels, petMaxStock, petSnackPack, petSnackPrice, type PetWarehouse } from '../../utils/petCatalog'
defineProps<{ warehouse: PetWarehouse | undefined; busy: boolean; linked: boolean }>()
const emit = defineEmits<{ buy: [id: number] }>()
</script>

<template>
  <section class="pet-shop" aria-label="宠物商店">
    <header><h3>零食补给</h3><strong v-if="warehouse">{{ warehouse.coins }} 游戏币</strong></header>
    <p v-if="!warehouse">升级键盘固件后可以使用游戏币购买零食。</p>
    <template v-else>
      <p>每包 {{ petSnackPack }} 份，直接放入背包。兔子吃完主人投喂的零食可获得 2 游戏币。</p>
      <div class="products">
        <article v-for="(id, index) in petFruitIds" :key="id">
          <span class="item-icon" aria-hidden="true" :style="{ backgroundPositionX: -index * 16 + 'px' }"></span>
          <div><h4>{{ petFruitLabels[id] }}</h4><small>背包 {{ warehouse.snacks[index] }} 份</small></div>
          <button type="button" :aria-label="'购买' + petFruitLabels[id] + '，' + petSnackPrice + ' 游戏币'"
            :disabled="busy || warehouse.coins < petSnackPrice || warehouse.snacks[index] > petMaxStock - petSnackPack"
            @click="emit('buy', index + 1)">{{ petSnackPrice }} 币</button>
        </article>
      </div>
      <p v-if="!linked">当前使用本机预览存档。</p>
    </template>
  </section>
</template>

<style scoped>
.pet-shop { color:var(--settings-ink); }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
h3,h4 { margin:0; }
header strong { padding:5px 9px; border-radius:6px; background:#f0e3bd; color:#5f481e; font-size:13px; }
p,small { color:#49615f; font-size:12px; }
p { margin:7px 0 11px; }
.products { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:7px; }
article { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px; align-items:center; background:var(--settings-surface); padding:8px; border-radius:var(--settings-radius); }
h4 { font-size:13px; }
.item-icon { width:16px; height:16px; background:url('../../assets/pet/items.png') no-repeat; image-rendering:pixelated; }
button { color:white; background:var(--settings-accent); border:0; border-radius:6px; padding:6px 9px; white-space:nowrap; font:inherit; font-size:12px; cursor:pointer; }
button:hover:enabled { background:var(--settings-accent-hover); }
button:disabled { opacity:.5; cursor:default; }
@media(max-width:460px) { .products { grid-template-columns:1fr; } }
</style>
