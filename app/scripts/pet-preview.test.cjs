const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const path = resolve(__dirname, '../src/components/screenPage/petItemPreview.ts')
const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
})

function preview(satiety = 65) {
  let now = 0
  let update
  let bedtime = false
  const context = { exports: {}, Date: { now: () => now }, window: {
    setInterval(fn) { update = fn; return 1 },
    clearInterval() { update = undefined }
  } }
  vm.runInNewContext(outputText, context)
  const state = { scene: 0, x: 128, action: 1, stats: { ...context.exports.previewCare, satiety } }
  const world = context.exports.createPetItemPreview(() => state, on => { bedtime = on })
  world.start()
  function tick(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 25) {
      now += 25
      update?.()
    }
  }
  return { world, state, tick, sleeping: () => bedtime }
}

test('each snack lands independently and surplus food waits until the rabbit is hungry', () => {
  const { world, state, tick } = preview()
  for (const id of [1, 1, 2, 3]) world.use(2, id)
  assert.equal(new Set(state.foods.map(f => f.x)).size, 4)
  tick(325)
  assert.equal(state.foods[0].y, Math.floor(-9 + 69 * .5 * 1.5))
  tick(12000)
  assert.equal(state.stats.satiety, 100)
  assert.equal(state.stats.mood, 79)
  assert.equal(state.stats.affection, 41)
  assert.equal(state.foods.length, 1)
  assert.equal(state.foods[0].stage, 1)
  // It naps in the nursery, then returns to the garden for the fourth snack.
  tick(60000)
  assert.equal(state.scene, 0)
  assert.equal(state.stats.satiety, 100)
  assert.equal(state.stats.affection, 43)
  assert.equal(state.foods.length, 0)
})

test('a full rabbit stays asleep with food nearby and wakes when hungry', () => {
  const { world, state, tick, sleeping } = preview(100)
  world.use(3, 2)
  tick(2300)
  assert.equal(state.scene, 1)
  assert.equal(state.action, 2)
  world.use(2, 1)
  tick(3200)
  assert.ok(sleeping())
  assert.equal(state.foods[0].stage, 1)
  tick(60000)
  assert.equal(state.foods.length, 0)
  assert.equal(state.stats.satiety, 100)
  assert.ok(!sleeping())
})

test('switching rooms interrupts a bite without consuming or rewarding it twice', () => {
  const { world, state, tick } = preview()
  world.use(2, 1)
  for (let i = 0; i < 120 && state.foods[0].stage !== 2; i++) tick(25)
  assert.equal(state.foods[0].stage, 2)
  world.changeScene(1)
  tick(1000)
  assert.equal(state.stats.satiety, 65)
  world.changeScene(0)
  assert.equal(state.foods.length, 1)
  tick(1500)
  assert.equal(state.foods.length, 0)
  assert.equal(state.stats.satiety, 77)
})

test('completed toy interactions and gestures reward once each, recalled toys do not', () => {
  const { world, state, tick } = preview()
  world.use(7, 2)
  tick(300)
  assert.equal(state.toyDrop, 46)
  world.use(7, 2)
  tick(3000)
  assert.equal(state.deployedToys[0], 0)
  assert.equal(state.stats.mood, 70)
  world.use(7, 2)
  tick(4000)
  assert.equal(state.deployedToys[0], 2)
  assert.equal(state.activeToy, 0)
  assert.equal(state.stats.sleepiness, 27)
  assert.equal(state.stats.mood, 76)
  world.use(11, 2)
  tick(2600)
  world.use(7, 1)
  tick(7000)
  assert.equal(state.stats.sleepiness, 17)
  assert.equal(state.stats.mood, 87)
  world.use(3, 11)
  tick(2100)
  assert.equal(state.stats.mood, 83)
  world.use(3, 12)
  tick(3100)
  assert.equal(state.stats.mood, 84)
  assert.equal(state.stats.affection, 42)
})
