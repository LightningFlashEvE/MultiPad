import type { ScreenFrame } from '../components/screenPage/screenContent'

export interface WorkLayer {
  keyConfig: { userKey: string; genKey: string }[][]
  screenConfig: ScreenFrame[]
}

export interface DeviceWorkLayout {
  menu: number
  bytes: Uint8Array
}

const emptyLayer: WorkLayer = { keyConfig: [], screenConfig: [] }
const usbPacket = 62
const flashPage = 4096
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function workLayerPayload(layer: WorkLayer) {
  const keys: Record<string, string> = {}
  let active = false
  for (let key = 0; key < 11; key++) {
    const events = layer.keyConfig[key]
    const eventCount = key < 8 ? 2 : 6
    const offset = key < 8 ? key * 2 : 16 + (key - 8) * 6
    for (let event = 0; event < eventCount; event++) {
      const setting = events?.[event]
      if (setting?.genKey) keys[String(offset + event).padStart(2, '0')] = setting.genKey
      active ||= Boolean(setting?.userKey || setting?.genKey)
    }
  }
  const pixels = [0, 1, 2].map(screen => layer.screenConfig[screen]?.buffData ?? [])
  active ||= layer.screenConfig.some(screen => screen?.content || screen?.baseData || screen?.buffData?.length)
  return { active, keys: JSON.stringify(keys), pixels }
}

export async function sendWorkConfiguration(
  layers: WorkLayer[],
  changed: number[],
  previous: DeviceWorkLayout | undefined,
  send: (bytes: Uint8Array) => Promise<boolean>,
  wait: (ms: number) => Promise<void> = pause
) {
  const layout = previous ? Uint8Array.from(previous.bytes) : new Uint8Array(31)
  const selected = new Set(previous ? changed : layers.map((_, index) => index))
  const payloads = layers.map(workLayerPayload)
  for (const index of selected) layout[index + 1] = Number(payloads[index].active)
  const enabled = () => Array.from(layout.subarray(1, 11), enabled => enabled === 1)
  let active = enabled()
  if (!active.includes(true)) {
    layout[1] = 1
    selected.add(0)
    payloads[0] = workLayerPayload(emptyLayer)
    active = enabled()
  }
  const preferred = previous?.menu || layout[0]
  layout[0] = active[preferred - 1] ? preferred : active.indexOf(true) + 1

  async function write(bytes: Uint8Array) {
    if (!await send(bytes)) throw Error('串口写入失败')
  }
  async function signal(value: number) {
    await write(Uint8Array.of(0xaa, 0xbb, value))
    await wait(2)
  }
  async function sendBlocks(bytes: Uint8Array, blockSize: number, settle: number, paced: boolean) {
    for (let base = 0; base < bytes.length; base += blockSize) {
      const end = Math.min(base + blockSize, bytes.length)
      for (let start = base; start < end; start += usbPacket) {
        await write(bytes.subarray(start, Math.min(start + usbPacket, end)))
        if (paced) await wait(1)
      }
      await wait(settle)
    }
  }
  async function sendLayer(index: number) {
    const { keys, pixels } = payloads[index]
    const encodedKeys = new TextEncoder().encode(keys)
    const keyData = encodedKeys.length % usbPacket === 0 ? Uint8Array.from([...encodedKeys, 32]) : encodedKeys
    await sendBlocks(keyData, flashPage, 1200, false)
    await signal(0xee)
    const oled = new Uint8Array(720)
    oled.set(Uint8Array.from(pixels[1], Number).subarray(0, 360))
    oled.set(Uint8Array.from(pixels[2], Number).subarray(0, 360), 360)
    await sendBlocks(oled, oled.length, 110, true)
    await signal(0xff)
    const color = Uint8Array.from(pixels[0], Number)
    if (color.length) await sendBlocks(color, flashPage, 130, true)
    else await write(Uint8Array.of(0, 0x11, 0x22))
    await wait(2000)
  }

  await signal(0xdd)
  await write(layout)
  await wait(150)
  for (const [index, enabled] of active.entries()) {
    if (!enabled) continue
    if (selected.has(index)) await sendLayer(index)
    else {
      await signal(0xaa)
      await wait(40)
    }
  }
  return layout
}
