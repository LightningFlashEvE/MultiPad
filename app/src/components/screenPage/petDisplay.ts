import { petActionLabels, petActions } from '../../utils/petCatalog'

export const petStats = [
  { id: 'satiety', label: '饱食度' },
  { id: 'sleepiness', label: '困意' },
  { id: 'mood', label: '心情值' },
  { id: 'affection', label: '好感度' }
] as const

export const petParameters = [
  ...petStats,
  { id: 'action', label: '当前动作' },
  { id: 'hour', label: '场景时间' },
  { id: 'season', label: '场景季节' },
  { id: 'fruit', label: '当前水果' },
  { id: 'queue', label: '待投喂数' }
] as const

export type PetParameter = typeof petParameters[number]['id']
export const petSeasons = ['春', '夏', '秋', '冬']
export const petFruits = ['无', '苹果', '香蕉', '橙子', '葡萄', '草莓', '梨', '樱桃', '西瓜']

export interface PetState {
  active: boolean
  action: number
  x: number
  fruit: number
  hour: number
  season: number
  queue: number
  stats?: Record<typeof petStats[number]['id'], number>
  scene: number
  activeToy: number
  toyPhase: number
}

export function petValue(parameter: PetParameter, state: PetState) {
  switch (parameter) {
    case 'action': return petActionLabels[petActions[state.action]] ?? '—'
    case 'hour': return String(state.hour).padStart(2, '0') + ':00'
    case 'season': return petSeasons[state.season] ?? '—'
    case 'fruit': return petFruits[state.fruit] ?? '—'
    case 'queue': return String(state.queue)
    default: return state.stats ? String(state.stats[parameter]) : '—'
  }
}
