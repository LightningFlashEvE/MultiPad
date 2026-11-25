import type { PetState } from './petDisplay'
import { defaultHutchPosition, isHutchPosition } from '../../utils/petCatalog'

export const previewCare = { satiety: 65, sleepiness: 25, mood: 70, affection: 35 }
type Food = { id: number; x: number; droppedAt: number }
type Room = { toy: number; droppedAt: number; awaitingPlay: boolean; foods: Food[] }
type FoodActivity = { target: number; eatingAt?: number }
type RoomActivity = { item: 1 | 2 | 3; bedtime: boolean; usingAt?: number; gardenFood: boolean;
  fromX: number; fromY: number; walkStart: number }

const fallMs = 650
const clampStat = (value: number) => Math.max(0, Math.min(value, 100))

export function createPetItemPreview(state: () => PetState, setBedtime: (enabled: boolean) => void) {
  const rooms: Room[] = [0, 1].map(() => ({ toy: 0, droppedAt: 0, awaitingPlay: false, foods: [] }))
  let food: FoodActivity | undefined
  let play: RoomActivity | undefined
  let gesture: { action: number; until: number } | undefined
  let timer: number | undefined
  let lastTick = 0
  let leavingTable = false
  let nextLook = 10000
  let looks = 0
  let time = 0
  let lastInput = 0
  let patUntil = 0
  let rubIndex = 2
  let metabolism = 0
  let fatigue = 0
  let wasSleeping = false

  function reward(satiety: number, sleepiness: number, mood: number, affection: number) {
    const stats = state().stats!
    stats.satiety = clampStat(stats.satiety + satiety)
    stats.sleepiness = clampStat(stats.sleepiness + sleepiness)
    stats.mood = clampStat(stats.mood + mood)
    stats.affection = clampStat(stats.affection + affection)
  }

  function move(target: number, distance: number) {
    const pet = state()
    pet.x += Math.sign(target - pet.x) * Math.min(Math.abs(target - pet.x), distance)
    return pet.x === target
  }

  function switchRoom(scene: number) {
    if (scene === state().scene) return
    leavingTable = false
    state().scene = scene
    state().rabbitY = 139
    play = undefined
    food = undefined
    gesture = undefined
  }

  function place(room: Room, toy: number) {
    if (play?.item === 2) play = undefined
    room.toy = toy
    room.droppedAt = time
    room.awaitingPlay = !!toy
  }

  function startActivity(item: 1 | 2 | 3, bedtime = false, gardenFood = false) {
    play = { item, bedtime, gardenFood, fromX: state().x, fromY: state().rabbitY ?? 139, walkStart: time }
  }

  function visitHutch(bedtime: boolean) {
    const gardenFood = state().scene === 0 && rooms[0].foods.length > 0
    switchRoom(1)
    startActivity(1, bedtime, gardenFood)
  }

  function update() {
    const now = Date.now()
    const dt = Math.max(0, Math.min(now - lastTick, 60_000))
    lastTick = now
    time += dt
    const pet = state()
    const stats = pet.stats ??= { ...previewCare }
    pet.headPatRemaining = Math.max(0, patUntil - time)
    const sleeping = pet.action === 2
    if (wasSleeping !== sleeping) fatigue = 0
    wasSleeping = sleeping
    fatigue += dt
    const interval = sleeping ? 20_000 : 60_000
    const steps = Math.floor(fatigue / interval)
    if (steps) { reward(0, sleeping ? -steps : steps, 0, 0); fatigue %= interval }
    metabolism += dt
    if (metabolism >= 60_000) {
      reward(-1, 0, stats.satiety < 25 || stats.sleepiness > 85 ? -1 : 0, 0)
      metabolism %= 60_000
    }

    if (pet.headPatRemaining && dt) {
      if (gesture) gesture.until += dt
      if (play) { play.walkStart += dt; if (play.usingAt !== undefined) play.usingAt += dt }
      if (food?.eatingAt !== undefined) food.eatingAt += dt
      return
    }
    if (leavingTable) {
      const dy = Math.min(dt * .056, 139 - (pet.rabbitY ?? 139))
      pet.rabbitY = (pet.rabbitY ?? 139) + dy
      pet.x += dy
      pet.facing = 1
      leavingTable = pet.rabbitY < 139
      if (leavingTable) return
    }
    const hungry = stats.satiety < 90
    if (play?.bedtime && stats.sleepiness <= 5) { play = undefined; lastInput = time }
    if (play?.bedtime && hungry && play.gardenFood && !rooms[1].foods.length && rooms[0].foods.length) switchRoom(0)
    let room = rooms[pet.scene]
    const first = room.foods[0]
    if (first && time - first.droppedAt >= fallMs && hungry) {
      if (play?.bedtime) play = undefined
      if (!play && !food) food = { target: first.x - (first.x >= pet.x ? 28 : -28) }
    }
    if (gesture && (food || time >= gesture.until)) {
      if (!food && gesture.action === 11) reward(0, 1, -4, 0)
      if (!food && gesture.action === 12) reward(0, 0, 1, 1)
      gesture = undefined
    }
    if (!play && stats.mood < 90 && stats.sleepiness < 85 && room.awaitingPlay && time - room.droppedAt >= fallMs && !food && !(hungry && first)) {
      room.awaitingPlay = false
      startActivity(2)
      gesture = undefined
    }
    if (!play && !food && !gesture && (!first || !hungry) && stats.sleepiness >= 25 && time - lastInput >= 18_000) {
      visitHutch(true)
      room = rooms[pet.scene]
    }
    if (!play && !food && !gesture && time >= nextLook && time - lastInput >= 6000) {
      nextLook = time + 12000
      if (++looks % 2 === 0 && pet.scene === 1) startActivity(3)
      else gesture = { action: 13, until: time + 2600 }
    }
    if (play) {
      const hutch = play.item === 1
      if (play.usingAt === undefined) {
        if (hutch || play.item === 3) {
          const target = hutch ? pet.hutchPosition ?? defaultHutchPosition : { x: 98, y: 116 }
          const dx = target.x - play.fromX, dy = target.y - play.fromY
          const distance = Math.max(Math.abs(dx), Math.abs(dy))
          const progress = distance ? Math.min(1, (time - play.walkStart) * .078 / distance) : 1
          pet.x = play.fromX + Math.trunc(dx * progress)
          pet.rabbitY = play.fromY + Math.trunc(dy * progress)
          if (progress === 1) { pet.x = target.x; pet.rabbitY = target.y; play.usingAt = time }
        } else if (move(151, dt * .078)) play.usingAt = time
      } else if (!play.bedtime && time - play.usingAt >= (hutch ? 4500 : play.item === 3 ? 3400 : 2400)) {
        leavingTable = play.item === 3
        if (play.item !== 3) reward(0, hutch ? -12 : 2, hutch ? 5 : 6, 2)
        lastInput = time
        play = undefined
      }
    } else if (food) {
      if (food.eatingAt === undefined) {
        if (move(food.target, dt * .088)) food.eatingAt = time
      } else if (time - food.eatingAt >= 850) {
        room.foods.shift()
        food = undefined
        reward(12, 0, 3, 2)
        lastInput = time
      }
    }
    const foods = room.foods.map((item, index) => {
      const t = Math.min(1, (time - item.droppedAt) / fallMs)
      return { id: item.id, x: item.x, y: Math.floor(-9 + 69 * t * (1 + t)),
        stage: index === 0 && food?.eatingAt !== undefined ? 2 : t === 1 ? 1 : 0 }
    })
    const toyPhase = !play ? 0 : play.usingAt === undefined ? 1 : 2
    pet.action = play ? toyPhase === 1 ? 1 : play.item === 1 ? 2 : play.item === 3 ? 14 : 3 :
      food ? food.eatingAt === undefined ? 5 : 3 : leavingTable ? 1 : gesture?.action ?? 0
    pet.activeToy = play?.item ?? 0
    if (pet.activeToy === 3 && toyPhase === 2) pet.facing = -1
    if (!leavingTable && pet.activeToy !== 1 && pet.activeToy !== 3) pet.rabbitY = 139
    pet.toyPhase = toyPhase
    pet.fruit = food ? foods[0].id : 0
    pet.queue = foods.length - Number(!!food)
    if (rooms.some((r, index) => r.toy !== pet.deployedToys?.[index])) pet.deployedToys = rooms.map(r => r.toy)
    pet.toyDrop = room.toy ? Math.min(100, Math.floor((time - room.droppedAt) * 100 / fallMs)) : 100
    if (foods.length || pet.foods?.length || !pet.foods) pet.foods = foods
    setBedtime(!!play?.bedtime)
  }

  function start() {
    if (timer !== undefined) return
    lastTick = Date.now()
    lastInput = time
    timer = window.setInterval(update, 60)
    update()
  }
  function pause() {
    if (timer === undefined) return
    window.clearInterval(timer)
    timer = undefined
    patUntil = 0
    state().headPatRemaining = 0
  }
  function changeScene(scene: number) {
    start()
    switchRoom(scene)
    lastInput = time
    update()
  }

  function use(command: number, value: number) {
    start()
    update()
    const pet = state()
    const hungry = pet.stats!.satiety < 90
    const room = rooms[pet.scene]
    if (command === 22) {
      if (value < 0 || value > 23 || value === 7 || !Number.isInteger(value)) return '无法识别摸头手势。'
      if (value === 5 || value === 6) {
        if (time < patUntil && pet.headPatKind) patUntil = time + (value === 5 ? 200 : 1200)
        update()
        return ''
      }
      if (value < 3 && time >= patUntil) reward(0, 0, 1, 1)
      patUntil = time + 1200
      pet.headPatKind = value >= 8 ? (value < 16 ? 1 : 2) : value > 2 ? value - 2 : value
      if (value <= 2) rubIndex = 2
      rubIndex = value >= 8 ? value % 8 : (rubIndex + (pet.headPatKind === 1 ? 1 : 7)) % 8
      pet.headPatPhase = 2 + rubIndex
    } else if (command === 2) {
      if (room.foods.length >= 8) return '场内已有八份零食。'
      const preferred = pet.x + (value % 2 ? 77 : -77)
      const lanes = Array.from({ length: 8 }, (_, i) => 41 + i * 34)
      const free = lanes.filter(x => room.foods.every(item => item.x !== x))
      const x = free.reduce((a, b) => Math.abs(a - preferred) <= Math.abs(b - preferred) ? a : b)
      room.foods.push({ id: value, x, droppedAt: time })
      if (play?.bedtime && hungry) play = undefined
    } else if (command === 7) {
      place(room, room.toy === value ? 0 : value)
    } else if (command === 11) {
      if (room.toy !== value) return '请先投放玩具。'
      if (time - room.droppedAt < fallMs || !!play || (hungry && room.foods.length)) return '兔子正在忙，请稍后再试。'
      room.awaitingPlay = false
      startActivity(2)
    } else if (command === 14) {
      const position = { x: value & 511, y: value >> 9 }
      if (!isHutchPosition(position.x, position.y)) return '请将兔窝放在场景范围内。'
      pet.hutchPosition = position
      if (play?.item === 1) {
        if (play.usingAt === undefined) {
          play.fromX = pet.x
          play.fromY = pet.rabbitY ?? 139
          play.walkStart = time
        } else { pet.x = position.x; pet.rabbitY = position.y }
      }
    } else if (command === 15) {
      if (food) return '兔子正在吃零食。'
      if (play?.item !== 1) visitHutch(false)
    } else if (command === 3) {
      if (food || (value !== 2 && play && !play.bedtime)) return '兔子正在忙，请稍后再试。'
      if (value === 14) {
        if (pet.scene !== 1 || play) return '请在宝宝房空闲时查看玩具桌。'
        startActivity(3)
      } else if (value === 2) {
        if (!play?.bedtime) visitHutch(true)
      } else {
        play = undefined
        gesture = value === 0 ? undefined : { action: value, until: time + (value === 12 ? 3000 : value === 13 ? 2600 : 2050) }
      }
    }
    lastInput = time
    update()
    return ''
  }
  function reset() {
    pause()
    play = undefined
    food = undefined
    gesture = undefined
    metabolism = fatigue = time = 0
    wasSleeping = false
    nextLook = 10000
    looks = 0
    leavingTable = false
    for (const room of rooms) { room.toy = 0; room.awaitingPlay = false; room.foods.length = 0 }
  }
  return { use, start, pause, changeScene, reset }
}
