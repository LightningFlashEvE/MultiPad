<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '../../stores/configStore'

const configStore = useConfigStore()
const router = useRouter()

const showFuncBox = (funcIndex: number) => {
  router.push(`/config/${funcIndex}`)
  configStore.setFuncShow(true)
}

const funcArray = reactive([
  {
    funcIndex: 0,
    funcName: '预制快捷键',
    funcDesc: '常用软件快捷键直接选择'
  },
  {
    funcIndex: 1,
    funcName: '菜单控制',
    funcDesc: '设置切换上一级、下一级菜单或者切换到固定的菜单'
  },
  {
    funcIndex: 2,
    funcName: '组合键值',
    funcDesc: '普通按键或者包含特殊按键的快捷键，不限制长度'
  },
  {
    funcIndex: 3,
    funcName: '发送文本',
    funcDesc: '按键之后会打出设置好的文本，有长度限制，如果文本中包含中文，就需要借助上位机'
  },
  {
    funcIndex: 4,
    funcName: '组合延迟键值',
    funcDesc: '组合键值中可以穿插延迟，适用于需要等待加载的场合'
  },
  {
    funcIndex: 5,
    funcName: '打开文件/应用',
    funcDesc: '通过设置路径来打开对应的文件或应用'
  },
  {
    funcIndex: 6,
    funcName: '特殊按键',
    funcDesc: '特殊的按键类似 F1、方向键、删除键...'
  },
  {
    funcIndex: 7,
    funcName: '媒体按键',
    funcDesc: '设置固定的媒体按键，类似打开计算器，或音量控制之类的应用'
  },
  {
    funcIndex: 8,
    funcName: '鼠标控制',
    funcDesc: '可以设置鼠标上下左右移动的距离，左中右键的点击，以及中键的上下位移'
  }
])
</script>

<template>
  <div id="func-content" class="settings-scroll">
    <ul>
      <li v-for="v in funcArray" :key="v.funcIndex">
        <button type="button" class="func-option" @click="showFuncBox(v.funcIndex)">
          <strong>{{ v.funcName }}</strong>
          <small>{{ v.funcDesc }}</small>
        </button>
      </li>
    </ul>
  </div>
</template>

<style lang="scss" scoped>
#func-content { min-height:0; flex:1; }
ul { list-style:none; display:grid; gap:5px; padding:2px; }
.func-option { display:block; width:100%; padding:6px 9px; border:0; border-radius:8px; background:var(--settings-canvas); color:var(--settings-ink); font:inherit; text-align:left; cursor:pointer; }
.func-option:hover { background:var(--settings-selected); }
.func-option strong, .func-option small { display:block; }
.func-option strong { font-size:13px; font-weight:650; }
.func-option small { margin-top:2px; color:var(--settings-muted); font-size:12px; line-height:1.4; }
</style>
