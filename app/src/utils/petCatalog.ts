// The array positions are action and scene IDs on the USB wire. Append new IDs.
export const petActions = ['idle', 'walk', 'sleep', 'eat', 'fall', 'fetch', 'run', 'jump', 'daydream', 'flee', 'blink', 'trip_angry', 'gaze_owner'] as const
export const playableActions = ['idle', 'blink', 'walk', 'run', 'jump', 'sleep', 'daydream', 'eat', 'flee', 'trip_angry', 'gaze_owner'] as const
export const petActionLabels: Record<typeof petActions[number], string> = {
  idle: '待机', walk: '散步', sleep: '睡觉', eat: '吃东西', fall: '水果掉落', fetch: '捡水果',
  run: '奔跑', jump: '跳跃', daydream: '做白日梦', flee: '受惊逃跑', blink: '眨眼',
  trip_angry: '绊脚生气', gaze_owner: '面向主人发呆'
}
export const petScenes = ['garden', 'nursery'] as const
export const petSceneLabels: Record<typeof petScenes[number], string> = { garden: '花园', nursery: '宝宝房' }

export const petToys = [
  { id: 'rabbit_hutch', wireId: 1, scene: 'nursery', label: '兔窝', description: '走到兔窝里休息片刻。' }
] as const satisfies readonly { id: string; wireId: number; scene: typeof petScenes[number]; label: string; description: string }[]

export type PetToyId = typeof petToys[number]['id']
export const petToyIds = petToys.map(toy => toy.id) as [PetToyId, ...PetToyId[]]
export const petToyPhases = ['idle', 'approaching', 'using'] as const
