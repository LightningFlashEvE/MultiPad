import { DEVICE_SCREEN_SIZES } from '../../utils/deviceScreenFormat'
import { performanceLcdFont } from './performanceLcdFont'
import { performanceLcdLabels } from './performanceLcdLabels'

export const { width, height } = DEVICE_SCREEN_SIZES[0]

export const performanceLabels = ['处理器', '内存', '系统盘']
const rgb = (value: number) => {
  const red = Math.round(((value >> 11) & 31) * 255 / 31)
  const green = Math.round(((value >> 5) & 63) * 255 / 63)
  const blue = Math.round((value & 31) * 255 / 31)
  return `rgb(${red}, ${green}, ${blue})`
}
const accents = [0x5f18, 0x85df, 0xedf0].map(rgb)
const background = rgb(0x1106)
const panel = rgb(0x1968)
const track = rgb(0x324c)
const text = rgb(0xf7bf)

export function hasPerformanceReading(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 100
}

function drawText(ctx: CanvasRenderingContext2D, string: string, x: number, y: number,
  glyphWidth: number, glyphs: Record<string, readonly number[]>, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  for (const char of string) {
    glyphs[char]?.forEach((line, row) => {
      for (let col = 0; col < glyphWidth; col++) {
        if (line & (1 << col)) ctx.rect(x + col, y + row, 1, 1)
      }
    })
    x += glyphWidth
  }
  ctx.fill()
}

// Match show_performance in firmware/USER/Usb/screen_readback.c.
export function drawPerformanceLcd(ctx: CanvasRenderingContext2D, values: readonly number[]) {
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  drawText(ctx, '电脑性能监测', 14, 10, 24, performanceLcdLabels[24], text)
  performanceLabels.forEach((label, index) => {
    const y = 43 + 40 * index
    const accent = accents[index]
    const value = values[index]
    ctx.fillStyle = panel
    ctx.fillRect(12, y - 4, 296, 34)
    ctx.fillStyle = accent
    ctx.fillRect(12, y - 4, 3, 34)
    drawText(ctx, label, 25, y + 5, 16, performanceLcdLabels[16], text)
    drawText(ctx, hasPerformanceReading(value) ? `${String(value).padStart(3)}%` : '  --',
      250, y, 12, performanceLcdFont, accent)
    ctx.fillStyle = track
    ctx.fillRect(82, y + 10, 153, 9)
    if (hasPerformanceReading(value) && value > 0) {
      ctx.fillStyle = accent
      ctx.fillRect(82, y + 10, Math.floor(153 * value / 100), 9)
    }
  })
}
