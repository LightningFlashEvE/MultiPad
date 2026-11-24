// The array positions are action and scene IDs on the USB wire. Append new IDs.
export const petActions = ['idle', 'walk', 'sleep', 'eat', 'fall', 'fetch', 'run', 'jump', 'daydream', 'flee', 'blink', 'trip_angry', 'gaze_owner'] as const
export const playableActions = ['idle', 'blink', 'walk', 'run', 'jump', 'sleep', 'daydream', 'eat', 'flee', 'trip_angry', 'gaze_owner'] as const
export const petActionLabels: Record<typeof petActions[number], string> = {
  idle: '待机', walk: '散步', sleep: '睡觉', eat: '吃东西', fall: '水果掉落', fetch: '捡水果',
  run: '奔跑', jump: '跳跃', daydream: '做白日梦', flee: '受惊逃跑', blink: '眨眼',
  trip_angry: '绊脚生气', gaze_owner: '面向主人发呆'
}
export const petScenes = ['garden', 'nursery'] as const
export type PetScene = typeof petScenes[number]
export const petSceneLabels: Record<typeof petScenes[number], string> = { garden: '花园', nursery: '宝宝房' }

export const petFruitIds = ['apple', 'banana', 'orange', 'grape', 'strawberry', 'pear', 'cherry', 'watermelon'] as const
export const petFruitLabels: Record<typeof petFruitIds[number], string> = {
  apple: '苹果', banana: '香蕉', orange: '橙子', grape: '葡萄', strawberry: '草莓', pear: '梨', cherry: '樱桃', watermelon: '西瓜'
}

export const hutchBounds = { minX: 41, maxX: 280, minY: 69, maxY: 167 } as const
export const defaultHutchPosition = { x: 246, y: 142 } as const
export const petDecorations = [
  { id: 'rabbit_hutch', itemId: 9, wireId: 1, kind: 'decoration', minGeneration: 2, scenes: ['nursery'],
    label: '兔窝', description: '走进宝宝房的兔窝，蜷起来小憩片刻。' }
] as const
export const petToys = [
  { id: 'carrot_toy', itemId: 10, wireId: 2, kind: 'toy', minGeneration: 3, scenes: petScenes,
    label: '胡萝卜玩具', description: '走近胡萝卜，用鼻尖推着玩。' }
] as const
export const petRoomItems = [...petDecorations, ...petToys] as const

export function toysForScene(scene: PetScene | null, generation: number) {
  return petRoomItems.filter(item => (item.kind === 'toy' || generation < 4) &&
    item.minGeneration <= generation && item.scenes.some(value => value === scene))
}

export const petItems = [
  ...petFruitIds.map((id, index) => ({
    id, itemId: index + 1, wireId: index + 1, minGeneration: 1, kind: 'fruit' as const,
    label: petFruitLabels[id], description: '投喂一份' + petFruitLabels[id] + '。'
  })),
  ...petRoomItems
]

// Earlier firmware exposed the hutch through the toy API. Keep that input spelling available.
export type PetToyId = typeof petRoomItems[number]['id']
export const petToyIds = petRoomItems.map(item => item.id) as [PetToyId, ...PetToyId[]]
export const petToyPhases = ['idle', 'approaching', 'using'] as const
export const petFoodStages = ['falling', 'landed', 'eating'] as const

// Control state lengths include all visible foods; reject partial SPI/USB snapshots.
export function petStateGeneration(p: Uint8Array) {
  if (p.length === 12) return 1
  if (p.length === 19) return 2
  if (p.length < 33 || p[32] > 8) return 0
  const endOfFoods = 33 + 6 * p[32]
  const hasHutchPosition = p.length === endOfFoods + 4
  if ((!hasHutchPosition && p.length !== endOfFoods) ||
      p[16] >= petScenes.length || p[17] > petRoomItems.length || p[18] >= petToyPhases.length ||
      p.subarray(19, 27).some(id => id > petItems.length) ||
      p[28] > 59 || p[29] > petRoomItems.length || p[30] > petRoomItems.length || p[31] > 100) return 0
  for (let i = 33; i < endOfFoods; i += 6) {
    const x = p[i + 1] | (p[i + 2] << 8)
    const rawY = p[i + 3] | (p[i + 4] << 8)
    const y = rawY >= 0x8000 ? rawY - 0x10000 : rawY
    if (!p[i] || p[i] > petFruitIds.length || x >= 320 || y < -9 || y > 129 || p[i + 5] >= petFoodStages.length) return 0
  }
  if (!hasHutchPosition) return 3
  const x = p[endOfFoods] | (p[endOfFoods + 1] << 8)
  const y = p[endOfFoods + 2]
  if (p[29] === 1 || p[30] === 1 || !isHutchPosition(x, y) ||
      p[endOfFoods + 3] < hutchBounds.minY || p[endOfFoods + 3] > hutchBounds.maxY) return 0
  return 4
}

export function isHutchPosition(x: number, y: number) {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= hutchBounds.minX && x <= hutchBounds.maxX && y >= hutchBounds.minY && y <= hutchBounds.maxY
}
