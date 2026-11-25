const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

const source = readFileSync(resolve(__dirname, '../src/utils/workConfigSync.ts'), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const exportsForTest = {}
runInNewContext(outputText, { exports: exportsForTest, Uint8Array, TextEncoder }, { filename: 'workConfigSync.js' })
const { sendWorkConfiguration } = exportsForTest

const empty = () => ({ keyConfig: [], screenConfig: [] })
const immediate = async () => {}

test('sync writes edited layers and keeps other device layers and the active layer', async () => {
  const menus = Array.from({ length: 10 }, empty)
  menus[2].keyConfig[2] = [{ userKey: 'A', genKey: 'aa' }]
  const previous = new Uint8Array(31)
  previous[0] = 1
  previous[1] = 1
  previous[4] = 1
  const sent = []
  const result = await sendWorkConfiguration(menus, [2], { menu: 4, bytes: previous }, async bytes => {
    sent.push([...bytes])
    return true
  }, immediate)
  assert.deepEqual([...result.slice(0, 6)], [4, 1, 0, 1, 1, 0])
  assert.deepEqual(sent[0], [0xaa, 0xbb, 0xdd])
  assert.deepEqual(sent[2], [0xaa, 0xbb, 0xaa])
  assert.equal(Buffer.from(sent[3]).toString(), '{"04":"aa"}')
  assert.deepEqual(sent.at(-1), [0xaa, 0xbb, 0xaa])
  assert.equal(sent.filter(packet => packet.length === 3 && packet[2] === 0xee).length, 1)
})

test('clearing the last configured layer gives the device one blank layer and stops on a write failure', async () => {
  const menus = Array.from({ length: 10 }, empty)
  const previous = new Uint8Array(31)
  previous[0] = 6
  previous[6] = 1
  const result = await sendWorkConfiguration(menus, [5], { menu: 6, bytes: previous }, async () => true, immediate)
  assert.deepEqual([...result.slice(0, 11)], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  let writes = 0
  await assert.rejects(sendWorkConfiguration(menus, [5], { menu: 6, bytes: previous }, async () => ++writes < 2, immediate))
  assert.equal(writes, 2)
})
