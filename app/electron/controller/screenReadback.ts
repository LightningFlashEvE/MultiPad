import { DEVICE_SCREEN_SIZES, type DeviceScreens } from '../../src/utils/deviceScreenFormat'

const REQUEST_MAGIC = Buffer.from([0xaa, 0xbb, 0xc1, 0x53])
const RESPONSE_MAGIC = Buffer.from([0x4d, 0x50, 0x53, 1])
const HEADER_SIZE = 19
const MAX_CHUNK = 1024
const INFO = 0xff
const STATUS_OK = 0
const STATUS_EMPTY = 1

function crc16(bytes: Buffer) {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  return crc
}

export default class ScreenReadback {
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private pending?: { id: number; finish: (frame?: Buffer) => void }
  private reading = false
  private closed = false
  private delivered?: number

  constructor(private readonly write: (data: Buffer) => Promise<boolean>) {}

  get busy() {
    return this.reading
  }

  close() {
    this.closed = true
    this.pending?.finish()
  }

  accept(chunk: Buffer) {
    if (!this.pending) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.pending) {
      const start = this.buffer.indexOf(RESPONSE_MAGIC)
      if (start < 0) {
        this.buffer = this.buffer.subarray(-3)
        return
      }
      this.buffer = this.buffer.subarray(start)
      if (this.buffer.length < HEADER_SIZE) return
      const payloadSize = this.buffer.readUInt16LE(16)
      if (payloadSize > MAX_CHUNK) {
        this.buffer = this.buffer.subarray(1)
        continue
      }
      const frameSize = HEADER_SIZE + payloadSize + 2
      if (this.buffer.length < frameSize) return
      const frame = this.buffer.subarray(0, frameSize - 2)
      if (crc16(frame) !== this.buffer.readUInt16LE(frameSize - 2)) {
        this.buffer = this.buffer.subarray(1)
        continue
      }
      this.buffer = this.buffer.subarray(frameSize)
      if (frame.readUInt16LE(4) === this.pending.id) this.pending.finish(frame)
    }
  }

  private async exchange(screen: number, generation = 0, offset = 0, length = 0) {
    if (this.closed) return
    const id = this.sequence = this.sequence % 65535 + 1
    const request = Buffer.alloc(17)
    REQUEST_MAGIC.copy(request)
    request.writeUInt16LE(id, 4)
    request.writeUInt32LE(generation, 6)
    request[10] = screen
    request.writeUInt32LE(offset, 11)
    request.writeUInt16LE(length, 15)

    return new Promise<Buffer | undefined>((resolve) => {
      const finish = (frame?: Buffer) => {
        if (this.pending?.id !== id) return
        clearTimeout(timer)
        this.pending = undefined
        resolve(frame)
      }
      const timer = setTimeout(finish, 600)
      this.buffer = Buffer.alloc(0)
      this.pending = { id, finish }
      this.write(request).then((written) => {
        if (!written) finish()
      }).catch(() => finish())
    })
  }

  async read(knownGeneration?: number): Promise<DeviceScreens> {
    if (this.closed) return { state: 'disconnected' }
    if (this.reading) return { state: 'busy' }
    this.reading = true
    try {
      const info = await this.exchange(INFO)
      if (!info || info[7] !== INFO) return { state: this.closed ? 'disconnected' : 'unavailable' }
      if (info[6] === STATUS_EMPTY) return { state: 'empty' }
      const generation = info.readUInt32LE(8)
      const menu = info[18]
      if (info[6] !== STATUS_OK || menu < 1 || menu > 10) return { state: 'unavailable' }
      if (generation === knownGeneration && generation === this.delivered) return { state: 'unchanged' }

      const pixels = []
      for (const [screen, { bytes }] of DEVICE_SCREEN_SIZES.entries()) {
        const image = new Uint8Array(bytes)
        for (let offset = 0; offset < bytes; offset += MAX_CHUNK) {
          const length = Math.min(MAX_CHUNK, bytes - offset)
          const frame = await this.exchange(screen, generation, offset, length)
          if (!frame) return { state: this.closed ? 'disconnected' : 'unavailable' }
          if (frame[6] !== STATUS_OK || frame[18] !== menu || frame.readUInt32LE(8) !== generation) {
            return { state: 'busy' }
          }
          if (frame[7] !== screen || frame.readUInt32LE(12) !== offset || frame.length !== HEADER_SIZE + length) {
            return { state: 'unavailable' }
          }
          image.set(frame.subarray(HEADER_SIZE), offset)
        }
        pixels.push(image)
      }
      const latest = await this.exchange(INFO)
      if (!latest || latest[6] !== STATUS_OK || latest[18] !== menu || latest.readUInt32LE(8) !== generation) {
        return { state: 'busy' }
      }

      this.delivered = generation
      return { state: 'ready', menu, generation, pixels }
    } finally {
      this.reading = false
    }
  }
}
