const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')

const home = readFileSync(resolve(__dirname, '../src/window/HomePage.vue'), 'utf8')
const script = home.split('<script setup lang="ts">')[1].split('</script>')[0]
const ast = ts.createSourceFile('HomePage.ts', script, ts.ScriptTarget.Latest, true)
const names = ['restoreDisplayMode', 'setAppMode', 'refreshPetDevice']
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text))
assert.equal(functions.length, names.length)
const code = ts.transpileModule(functions.map(s => s.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  const ref = value => ({ value })
  const noop = () => {}
  const board = { session: 'first', active: false }
  const writes = []
  const ui = {
    appMode: ref('work'), conState: ref(false), petLinked: ref(false), petNotice: ref(''),
    progressShow: ref(false), firmwareUpdating: ref(false), pendingScene: new Map(),
    petTask: undefined, petSession: undefined, requestedMode: undefined,
    previewWorld: { start: noop, pause: noop },
    liveScreens: { tick: noop, flushPetRefresh: noop, petRefreshPending: () => false },
    syncClock: noop, refreshDeviceScreens: noop, showOfflineTime: noop, storeMode: noop,
    hasPerformanceScreens: () => false, hasPetPayload: payload => payload?.length > 0,
    applyPetReply(reply) { ui.petSession = reply.session; ui.petLinked.value = true },
    win: { myApi: {
      getMenu: async () => 'pet',
      async petAction(command, value, expectedSession) {
        if (command === 1) {
          writes.push([value, expectedSession])
          assert.equal(expectedSession, board.session)
          board.active = Boolean(value)
          if (board.loseReply) return {state:'unavailable'}
        } else if (board.readFailed) return {state:'unavailable'}
        return {state:'ready', status:0, session:board.session, payload:Uint8Array.of(Number(board.active))}
      }
    } }
  }
  runInNewContext(code, ui)
  const refresh = async () => { ui.refreshPetDevice(); await ui.petTask }
  return { board, writes, ui, refresh }
}

test('startup preference, offline clicks and recovery follow the physical keyboard on reconnect', async () => {
  const { board, writes, ui, refresh } = fixture()
  await ui.restoreDisplayMode()
  assert.equal(ui.appMode.value, 'pet')
  ui.setAppMode('work')
  ui.setAppMode('pet')
  ui.conState.value = true
  await refresh()
  assert.equal(ui.appMode.value, 'work')
  await ui.restoreDisplayMode()
  assert.equal(ui.appMode.value, 'work')
  board.active = true
  await refresh()
  board.readFailed = true
  await refresh()
  board.active = false
  board.readFailed = false
  await refresh()
  assert.equal(ui.appMode.value, 'work')
  assert.deepEqual(writes, [])
})

test('explicit mode clicks write once to the observed session, including on a lost reply', async () => {
  const { board, writes, ui, refresh } = fixture()
  ui.conState.value = true
  await refresh()
  board.loseReply = true
  ui.setAppMode('pet')
  await ui.petTask
  await refresh()
  assert.deepEqual(writes, [[1,'first']])
  assert.equal(ui.appMode.value, 'pet')
  board.session = 'second'
  ui.setAppMode('work')
  await ui.petTask
  assert.equal(ui.appMode.value, 'pet')
  assert.equal(writes.length, 1)
  board.loseReply = false
  ui.setAppMode('work')
  await ui.petTask
  assert.deepEqual(writes, [[1,'first'],[0,'second']])
})
