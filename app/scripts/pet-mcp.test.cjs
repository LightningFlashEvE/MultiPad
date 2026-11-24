const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { compileFunction } = require('node:vm')
const ts = require('typescript')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')

// Exercise the real SDK, tool registration and model adapter. Replace the keyboard,
// credential store, timer and model endpoint without opening COM or making network requests.
function loadModule(relative, dependencies = {}, globals = {}) {
  const file = resolve(__dirname, relative)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const exports = {}
  const load = name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)
  compileFunction(code, ['require', 'exports', ...Object.keys(globals)], { filename: file })(load, exports, ...Object.values(globals))
  return exports
}

const session = 'cccccccc-0000-0000-0000-000000000000'
const pathToCatalog = '../../src/utils/petCatalog'
const catalog = loadModule('../src/utils/petCatalog.ts')
const guide = loadModule('../electron/controller/petCareGuide.ts', { [pathToCatalog]: catalog })
function payload(generation = 4, fields = {}, foodIds = []) {
  const p = Buffer.alloc(37 + foodIds.length * 6)
  p.set([1,0,78,0,0,0,0,0,0,12,1,0,65,24,68,45,1,0,0])
  p[31] = 100
  p[32] = foodIds.length
  foodIds.forEach((id, i) => p.set([id,41+i*34,0,129,0,1],33+i*6))
  p.set([246,0,142,139], p.length - 4)
  for (const [i,v] of Object.entries(fields)) p[Number(i)] = v
  return p.subarray(0, generation === 1 ? 12 : generation === 2 ? 19 : generation === 3 ? p.length-4 : p.length)
}
function eventPage(events) {
  const p = Buffer.alloc(1 + events.length * 12)
  for (const [i, [kind,value,source,detail]] of events.entries()) {
    const offset = 1 + 12*i
    p.writeUInt32LE(i+1, offset)
    p.writeUInt32LE((i+1)*40, offset+4)
    p.set([kind,value,source,detail],offset+8)
  }
  return p
}

function fixture(t) {
  const board = { payload: payload(), requests: [], events: [], status: 0 }
  const serial = { pet: async request => {
    board.requests.push(request)
    const bytes = 'after' in request ? (request.after ? Buffer.from([0]) : eventPage(board.events)) : board.payload
    return { state: 'ready', session, status: board.status, payload: bytes }
  } }
  const mcp = loadModule('../electron/controller/petMcp.ts', {
    './serialPort': serial, [pathToCatalog]: catalog, './petCareGuide': guide
  })
  const server = mcp.createPetMcp(), client = new Client({name:'test',version:'1'})
  const [c,s] = InMemoryTransport.createLinkedPair()
  t.after(() => Promise.all([client.close(), server.close()]))
  return { board, mcp, client, async start() { await server.connect(s); await client.connect(c) },
    async call(name,args={}) { const r = await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r.content));return r.structuredContent } }
}

test('an MCP client discovers the offline care guide and generation-specific actions', async t => {
  const f = fixture(t)
  await f.start()
  assert.match(f.client.getInstructions(), /pet_get_care_guide/)
  assert.match(f.client.getInstructions(), /pet_get_events/)
  const tool = (await f.client.listTools()).tools.find(x => x.name === 'pet_get_care_guide')
  assert(tool.annotations.readOnlyHint)
  const rules = await f.call(tool.name)
  assert.match(rules.actions.eat, /饱食度/)
  assert.equal(Object.keys(rules.food.fruits).length, 8)
  assert.deepEqual(f.board.requests, [])
  for (const generation of [1,2,3,4]) {
    f.board.payload = payload(generation)
    const state = await f.call('pet_get_state'), a = state.availableNow
    assert.equal(state.generation, generation)
    assert.equal(a.actions.includes('gaze_owner'), generation >= 2)
    assert(!a.actions.includes('fetch'));assert(!a.actions.includes('fall'))
    assert.equal(a.placeToys.includes('carrot_toy'), generation >= 3)
    assert.equal(a.useToys.includes('rabbit_hutch'), generation === 2 || generation === 3)
    assert.equal(a.visitDecorations.includes('rabbit_hutch'), generation >= 4)
  }
  f.board.payload = payload(2, {17:1,18:2})
  const old = (await f.call('pet_get_state')).availableNow
  assert.equal(old.feed,false);assert.deepEqual(old.actions,[]);assert.deepEqual(old.scenes,['nursery'])
})

test('live availability follows floor capacity, satiety, rest, toy drop and work mode', async t => {
  const f=fixture(t);await f.start()
  const available=async(fields,ids=[])=>{
    f.board.payload=payload(4,fields,ids)
    return (await f.call('pet_get_state')).availableNow
  }
  let a=await available({12:100,27:1,30:2},[1])
  assert(a.feed);assert.equal(a.foodSlots,7);assert(!a.actions.includes('eat'))
  assert(!a.setHour);assert.deepEqual(a.interactToys,['carrot_toy'])
  a=await available({30:2,31:25})
  assert.deepEqual(a.interactToys,[]);assert.deepEqual(a.placeToys,['carrot_toy'])
  a=await available({8:1},[1,2,3,4,5,6,7,8])
  assert(!a.feed);assert.deepEqual(a.actions,[]);assert.deepEqual(a.visitDecorations,[])
  a=await available({17:1,18:2,1:2})
  assert.deepEqual(a.actions,['sleep']);assert.deepEqual(a.interactToys,[])
  a=await available({17:1,18:2,1:2,27:2})
  assert(a.actions.includes('idle'));assert.match(a.careNote,/长睡/)
  a=await available({0:0})
  assert(!a.feed);assert.deepEqual(a.actions,[]);assert.deepEqual(a.moveDecorations,[]);assert(!a.setHour)
  assert(a.setMode)
  f.board.status=5
  const failed=await f.client.callTool({name:'pet_feed',arguments:{fruit:'apple'}})
  assert(failed.isError);assert.equal(failed.structuredContent.error.code,'inactive')
})

test('model sees its personality, limited recent activity and care state without host credentials', async t => {
  const f=fixture(t)
  const saved=new Map()
  class Store { get(key){return saved.get(key)} set(key,value){saved.set(key,value)} }
  let timer, modelRequest, nextTool
  const ai=loadModule('../electron/controller/petAi.ts',{
    electron:{safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}},
    'electron-store':Store,'./petMcp':f.mcp,'./petCareGuide':guide,[pathToCatalog]:catalog,
    '../../src/utils/petPersonality':loadModule('../src/utils/petPersonality.ts')
  },{
    setTimeout(fn,ms){if(ms===1500)timer=fn;return 1},clearTimeout(){},
    async fetch(_url,options){
      modelRequest=JSON.parse(options.body)
      const message=nextTool?{tool_calls:[{type:'function',function:{name:nextTool,arguments:'{"fruit":"apple"}'}}]}:{}
      return new Response(JSON.stringify({choices:[{message}]}))
    }
  })
  t.after(()=>ai.stopPetAi())
  const cfg={apiUrl:'http://localhost:19377/v1',model:'fixture',apiKey:'secret-mcp-regression-key',personality:'胆小，喜欢在窝边观察主人。',enabled:false}
  ai.savePetAi(cfg)
  nextTool='pet_feed'
  assert.equal((await ai.testPetAi('connection')).status.phase,'idle')
  assert.deepEqual(f.board.requests,[])
  nextTool=undefined
  const auto=async()=>{
    ai.savePetAi({...cfg,enabled:true});timer()
    const end=Date.now()+2500
    while(ai.getPetAi().running&&Date.now()<end)await new Promise(r=>setImmediate(r))
    assert(!ai.getPetAi().running);assert.equal(ai.getPetAi().status.phase,'idle')
    return JSON.parse(modelRequest.messages[1].content)
  }
  f.board.events=Array.from({length:14},(_,i)=>i%2===0 ? [8,1,1,10] : [2,12,0,0])
  f.board.payload=payload(4,{12:100},[1])
  let message=await auto()
  assert.match(modelRequest.messages[0].content,/垂耳兔/)
  assert.equal(message.personality,cfg.personality)
  assert.equal(message.observation.generation,4)
  assert.deepEqual(message.observation.foods,[{fruit:'apple',x:41,y:129,stage:'landed'}])
  const recent=message.observation.recentActivity
  assert(recent.partial);assert.equal(recent.events.length,12)
  assert(recent.events.some(e=>e.source==='physical'&&e.key===1&&e.item==='carrot_toy'&&e.toy==='carrot_toy'))
  assert(recent.events.some(e=>e.source==='automatic'&&e.action==='gaze_owner'))
  assert.match(message.observation.careNote,/吃饱/)
  assert(!modelRequest.tools.some(t=>t.function.name==='pet_feed'))
  for(const token of [cfg.apiKey,'localhost',session,'userData','session'])assert(!JSON.stringify(modelRequest.messages).includes(token))
  f.board.payload=payload(1)
  message=await auto()
  assert.equal(message.observation.stats,null);assert.equal(message.observation.recentActivity.events.length,0)
  assert(!modelRequest.tools.some(t=>t.function.name.includes('toy')||t.function.name.includes('decoration')))
  assert(!modelRequest.tools.find(t=>t.function.name==='pet_play_action').function.parameters.properties.action.enum.includes('trip_angry'))
  assert(!f.board.requests.some(r=>r.command>0))
})
