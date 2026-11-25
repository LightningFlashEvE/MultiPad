const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

function loadSource(path, imports = {}) {
  const source = readFileSync(resolve(__dirname, path), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const exports = {}
  runInNewContext(outputText, { exports, require: id => imports[id] }, { filename: path })
  return exports
}

const font = loadSource('../src/components/screenPage/performanceLcdFont.ts')
const labels = loadSource('../src/components/screenPage/performanceLcdLabels.ts')
const { drawPerformanceLcd } = loadSource('../src/components/screenPage/performanceLcd.ts', {
  '../../utils/deviceScreenFormat': loadSource('../src/utils/deviceScreenFormat.ts'),
  './performanceLcdFont': font,
  './performanceLcdLabels': labels
})

test('percentages use the firmware bitmap rows', () => {
  const source = readFileSync(resolve(__dirname, '../../firmware/HARDWARE/LCD/LCD_47/lcdfont.h'), 'utf8')
  const block = source.split('const unsigned char ascii_2412')[1].split('};')[0]
  const glyphs = [...block.matchAll(/\{([0-9a-fx,\s]+)\}/gi)]
  for (const char of '0123456789%-') {
    const bytes = glyphs[char.charCodeAt(0) - 32][1].match(/0x[0-9a-f]+/gi).map(Number)
    const rows = Array.from({ length: 24 }, (_, row) => bytes[row * 2] | bytes[row * 2 + 1] << 8)
    assert.deepEqual([...font.performanceLcdFont[char]], rows)
  }
})

test('Chinese performance labels match the keyboard glyphs and order', () => {
  const source = readFileSync(resolve(__dirname, '../../firmware/USER/Usb/performance_labels.inc'), 'utf8')
  for (const [size, characters] of [[24, '电脑性能监测'], [16, '处理器内存系统盘']]) {
    const block = source.split(`performance_labels_${size}`)[1].split('};')[0]
    const glyphs = [...block.matchAll(/\{([0-9a-fx,\s]+)\}.*?U\+([0-9a-f]{4})/gi)]
    assert.equal(glyphs.map(([, , code]) => String.fromCharCode(parseInt(code, 16))).join(''), characters)
    for (const char of characters) {
      const rows = glyphs[characters.indexOf(char)][1].match(/0x[0-9a-f]+/gi).map(Number)
      assert.equal(rows.length, size)
      assert.ok(rows.some(row => row > 0))
      assert.deepEqual([...labels.performanceLcdLabels[size][char]], rows)
    }
  }
})

test('LCD preview draws full size, rounds bars down, and leaves missing or zero readings empty', () => {
  const pixels = new Map()
  let path
  const ctx = {
    fillRect(x, y, width, height) {
      for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) pixels.set(row * 320 + col, this.fillStyle)
      }
    },
    beginPath() { path = [] },
    rect(...bounds) { path.push(bounds) },
    fill() { path.forEach(bounds => this.fillRect(...bounds)) }
  }
  const colorAt = (x, y) => pixels.get(y * 320 + x)
  drawPerformanceLcd(ctx, [50, 255, 100])
  assert.equal(pixels.size, 320 * 172)
  assert.equal(colorAt(0, 0), 'rgb(16, 32, 49)')
  assert.equal(colorAt(157, 53), colorAt(12, 39))
  assert.equal(colorAt(158, 53), colorAt(82, 93))
  assert.equal(colorAt(234, 133), colorAt(12, 119))
  assert.notEqual(colorAt(235, 133), colorAt(234, 133))
  drawPerformanceLcd(ctx, [0, 255, 100])
  assert.equal(colorAt(82, 53), colorAt(82, 93))
})
