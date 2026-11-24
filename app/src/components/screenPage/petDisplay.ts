export const petParameters = [
  { id: 'action', label: '当前动作' },
  { id: 'hour', label: '场景时间' },
  { id: 'season', label: '场景季节' },
  { id: 'fruit', label: '当前水果' },
  { id: 'queue', label: '待投喂数' }
] as const

export type PetParameter = typeof petParameters[number]['id']
export const petActions = ['发呆', '散步', '睡觉', '吃水果', '水果掉落', '捡水果', '奔跑', '跳跃', '做白日梦', '躲避', '眨眼']
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
}

export function petValue(parameter: PetParameter, state: PetState) {
  switch (parameter) {
    case 'action': return petActions[state.action] ?? '—'
    case 'hour': return String(state.hour).padStart(2, '0') + ':00'
    case 'season': return petSeasons[state.season] ?? '—'
    case 'fruit': return petFruits[state.fruit] ?? '—'
    case 'queue': return String(state.queue)
  }
}
