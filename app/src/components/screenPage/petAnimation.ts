import atlasUrl from '../../assets/pet/frost-lop.png'
import sprite from '../../assets/pet/frost-lop.json'
import type { PetAction } from './petScene'

export const rabbitAtlasUrl = atlasUrl

const actionClips = {
  idle: 'daydream',
  walk: 'walk',
  sleep: 'sleep',
  eat: 'eat',
  react: 'jump'
} as const

function frameFor(action: PetAction, elapsed: number) {
  const blink = action === 'idle' && elapsed >= 1400 && elapsed < 1525
  const clip = sprite.clips[blink ? 'blink' : actionClips[action]]
  const total = clip.ticks.reduce((sum, duration) => sum + duration, 0)
  const elapsedTicks = Math.floor(elapsed * sprite.tickRateHz / 1000)
  let tick = clip.loop ? elapsedTicks % total : Math.min(elapsedTicks, total - 1)
  for (let i = 0; i < clip.ticks.length; i++) {
    if (tick < clip.ticks[i]) return clip.first + i
    tick -= clip.ticks[i]
  }
  return clip.first
}

export function drawRabbit(
  ctx: CanvasRenderingContext2D, atlas: HTMLImageElement, x: number, y: number,
  direction: number, action: PetAction, elapsed: number
) {
  if (!atlas.complete || !atlas.naturalWidth) return
  const { width, height, anchorX, anchorY } = sprite
  const frame = frameFor(action, elapsed)
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(direction, 1)
  ctx.drawImage(atlas, frame * width, 0, width, height, -anchorX, -anchorY, width, height)
  ctx.restore()
}
