const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')
const { transpileModule, ModuleKind } = require('typescript')

const sceneSource = path.join(__dirname, '../src/components/screenPage/petScene.ts')
const assetDir = path.join(__dirname, '../src/assets/pet')
const sprite = require(path.join(assetDir, 'frost-lop.json'))
const compiled = transpileModule(fs.readFileSync(sceneSource, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS }
})
const scene = {}
new Function('exports', compiled.outputText)(scene)

const palette = [0]
const paletteIndex = new Map()
const rgb565 = rgb => ((rgb >> 8) & 0xf800) | ((rgb >> 5) & 0x07e0) | ((rgb >> 3) & 0x1f)

function render(width, height, draw) {
  const pixels = new Uint8Array(width * height)
  draw({
    fillStyle: '',
    fillRect(x, y, w, h) {
      if (!paletteIndex.has(this.fillStyle)) {
        if (palette.length === 256) throw Error('Pet palette exceeds 256 colors')
        paletteIndex.set(this.fillStyle, palette.length)
        palette.push(rgb565(parseInt(this.fillStyle.slice(1), 16)))
      }
      const left = Math.max(0, x)
      const right = Math.min(width, x + w)
      const top = Math.max(0, y)
      const bottom = Math.min(height, y + h)
      if (right <= left) return
      for (let row = top; row < bottom; row++) {
        pixels.fill(paletteIndex.get(this.fillStyle), row * width + left, row * width + right)
      }
    }
  })
  return { width, height, pixels }
}

function encode(images) {
  const rows = []
  const runs = []
  for (const { width, height, pixels } of images) {
    for (let row = 0; row < height; row++) {
      rows.push(runs.length / 2)
      for (let x = 0; x < width;) {
        const color = pixels[row * width + x]
        let end = x + 1
        while (end < width && end - x < 255 && pixels[row * width + end] === color) end++
        runs.push(end - x, color)
        x = end
      }
    }
  }
  rows.push(runs.length / 2)
  return { rows, runs }
}

function cArray(type, name, values, format = String) {
  const lines = []
  for (let start = 0; start < values.length; start += 20) {
    lines.push('    ' + values.slice(start, start + 20).map(format).join(', ') + ',')
  }
  return 'static const ' + type + ' ' + name + '[] = {\n' + lines.join('\n') + '\n};\n'
}

async function readSprite() {
  const { data, info } = await sharp(path.join(assetDir, 'frost-lop.png'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = sprite
  if (info.channels !== 4 || info.height !== height || info.width % width !== 0) {
    throw Error('Unexpected rabbit atlas size')
  }
  const frameCount = info.width / width
  if (frameCount > 255) throw Error('Rabbit frame index exceeds uint8_t')
  const byColor = new Map(palette.slice(1).map((color, i) => [color, i + 1]))
  const images = []
  for (let frame = 0; frame < frameCount; frame++) {
    const pixels = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * info.width + frame * width + x) * 4
        if (data[offset + 3] === 0) continue
        if (data[offset + 3] !== 255) throw Error('Rabbit atlas must use binary transparency')
        const color = rgb565((data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2])
        if (!byColor.has(color)) {
          if (palette.length === 256) throw Error('Pet palette exceeds 256 colors')
          byColor.set(color, palette.length)
          palette.push(color)
        }
        pixels[y * width + x] = byColor.get(color)
      }
    }
    images.push({ width, height, pixels })
  }
  return images
}

function clipDefinitions(frameCount) {
  const entries = Object.entries(sprite.clips)
  const definitions = []
  const ids = []
  const clips = []
  for (const [name, { first, ticks, loop, loopFrom = 0 }] of entries) {
    const total = ticks.reduce((sum, tick) => sum + tick, 0)
    if (!Number.isInteger(first) || first < 0 || first + ticks.length > frameCount ||
        !ticks.length || total > 255 || !Number.isInteger(loopFrom) || loopFrom < 0 || loopFrom >= ticks.length ||
        ticks.some(tick => !Number.isInteger(tick) || tick < 1)) {
      throw Error('Invalid timing for rabbit clip ' + name)
    }
    const id = 'RABBIT_' + name.toUpperCase()
    ids.push(id)
    definitions.push(cArray('uint8_t', 'rabbit_ticks_' + name, ticks))
    const loopStart = ticks.slice(0, loopFrom).reduce((sum, tick) => sum + tick, 0)
    clips.push(`    [${id}] = {${first}, ${ticks.length}, ${total}, ${loop ? 1 : 0}, ${loopStart}, rabbit_ticks_${name}},`)
  }
  return [
    'enum {',
    `    RABBIT_WIDTH = ${sprite.width}, RABBIT_HEIGHT = ${sprite.height},`,
    `    RABBIT_ANCHOR_X = ${sprite.anchorX}, RABBIT_ANCHOR_Y = ${sprite.anchorY},`,
    `    RABBIT_FRUIT_CONTACT_X = ${sprite.fruitContactX}, RABBIT_TICK_RATE = ${sprite.tickRateHz}`,
    '};',
    `typedef enum { ${ids.join(', ')} } RabbitClipId;`,
    'typedef struct { uint8_t first, count, duration, loop, loop_start; const uint8_t *ticks; } RabbitClip;',
    ...definitions,
    'static const RabbitClip rabbit_clips[] = {',
    ...clips,
    '};\n'
  ].join('\n')
}

async function generate() {
  const garden = encode([render(320, 172, scene.drawGarden)])
  const frames = await readSprite()
  const rabbit = encode(frames)
  const nursery = encode([render(320, 172, scene.drawNursery)])
  if (rabbit.rows.at(-1) > 0xffff) throw Error('Rabbit row offsets exceed uint16_t')
  const output = [
    '/* MultiPad raster assets generated by app/scripts/generate-pet-art.cjs.\n' +
    ' * Shared with the desktop pet preview. */\n',
    clipDefinitions(frames.length),
    cArray('uint16_t', 'pet_palette', palette, color => '0x' + color.toString(16).padStart(4, '0')),
    cArray('uint16_t', 'garden_rows', garden.rows),
    cArray('uint8_t', 'garden_runs', garden.runs),
    cArray('uint16_t', 'nursery_rows', nursery.rows),
    cArray('uint8_t', 'nursery_runs', nursery.runs),
    cArray('uint16_t', 'rabbit_rows', rabbit.rows),
    cArray('uint8_t', 'rabbit_runs', rabbit.runs)
  ].join('\n')
  fs.writeFileSync(path.join(__dirname, '../../firmware/USER/Lcd/pet_art.inc'), output)
}

generate().catch(error => { console.error(error); process.exitCode = 1 })
