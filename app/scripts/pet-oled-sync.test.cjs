const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

const path = resolve(__dirname, '../src/components/screenPage/liveScreens.ts')
const source = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

test('a pet value change retries a busy OLED and sends the latest frames without the background tick', async () => {
  const exports = {}
  const timers = []
  const writes = []
  let paused = true
  let statusBusy = true
  let secondScreenBusy = true
  let value = 42
  let mask = 0
  let colorWrites = 0

  runInNewContext(source, {
    exports, Date, JSON, Promise, Number, Map, Uint8Array,
    setTimeout: callback => { timers.push(callback); return timers.length },
    clearTimeout() {},
    require(name) {
      if (name === 'vue') return { shallowReactive: map => map }
      assert.equal(name, './screenContent')
      return {
        renderScreenContent: async content => String(content.rows[0].value),
        encodeOled: async text => ({ baseData: text, buffData: [Number(text)] })
      }
    },
    window: { myApi: { liveOled: async operation => {
      if (!operation && statusBusy) {
        statusBusy = false
        return { state: 'busy' }
      }
      if (operation?.screen === 2 && secondScreenBusy) {
        secondScreenBusy = false
        return { state: 'busy' }
      }
      if (operation) {
        writes.push([operation.screen, operation.pixels[0]])
        mask |= 1 << (operation.screen - 1)
      }
      return { state: 'ready', code: 0, menu: 1, generation: 3, mask }
    } } }
  })

  const config = () => ({ content: { mode: 'pet', rows: [{ value }] } })
  const screens = exports.createLiveScreens(() => [undefined, config(), config()], () => paused,
    () => true, () => {}, async () => { colorWrites++ }, () => true)

  screens.refreshPet()
  value = 43
  screens.refreshPet()
  assert.equal(timers.length, 1)
  assert.deepEqual(writes, [])

  paused = false
  for (let i = 0; i < 3; i++) {
    assert.equal(typeof timers[0], 'function')
    timers.shift()()
    await screens.wait()
  }
  assert.deepEqual(writes, [[1, 43], [2, 43]])
  assert.equal(timers.length, 0)
  assert.equal(colorWrites, 0)
  assert.equal(screens.petRefreshPending(), false)

  paused = true
  value = 44
  screens.refreshPet()
  assert.equal(screens.petRefreshPending(), true)
  paused = false
  screens.flushPetRefresh()
  await screens.wait()
  assert.deepEqual(writes.slice(-2), [[1, 44], [2, 44]])
  assert.equal(screens.petRefreshPending(), false)
})
