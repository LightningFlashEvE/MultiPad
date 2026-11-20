import type { SerialPort as SerialPortInstance } from 'serialport'
import type { DeviceScreens } from '../../src/utils/deviceScreenFormat'
import ScreenReadback from './screenReadback'

const { SerialPort }: typeof import('serialport') = require('serialport')
const HANDSHAKE = Buffer.from([0xaa, 0xbb, 0xcc])
const READBACK_CAPABILITY = Buffer.from([0xaa, 0xbb, 0xcc, 0x4d, 0x50, 0x53, 0x43, 1])

export default class SerialConnect {
  private static port?: SerialPortInstance
  private static connectionAttempt?: Promise<boolean>
  private static screenReadback?: ScreenReadback
  private static waitState = false
  private static upgrading = false

  static connectHardware(): Promise<boolean> {
    if (this.upgrading) return Promise.resolve(false)
    if (this.port?.isOpen) return Promise.resolve(true)
    if (!this.connectionAttempt) {
      this.connectionAttempt = this.findHardware().finally(() => { this.connectionAttempt = undefined })
    }
    return this.connectionAttempt
  }

  static async withFirmwareUpdate<T>(run: () => Promise<T>): Promise<T> {
    if (this.upgrading) throw Error('固件升级正在进行')
    this.upgrading = true
    try {
      await this.connectionAttempt
      const port = this.port
      this.screenReadback?.close()
      this.screenReadback = undefined
      this.port = undefined
      this.waitState = false
      if (port?.isOpen) await new Promise<void>((resolve, reject) =>
        port.close(error => error ? reject(error) : resolve()))
      return await run()
    } finally {
      this.upgrading = false
    }
  }

  private static async findHardware() {
    try {
      const ports = await SerialPort.list()
      const address = (port: (typeof ports)[number]) =>
        `${port.vendorId}:${port.productId}`.toUpperCase()
      const knownKeyboards = ports.filter(port => ['07CF:4F0F', '5688:5966'].includes(address(port)))
      if (!knownKeyboards.length && ports.some(port => address(port) === '07CF:4F10')) {
        // A bootloader connection belongs to the updater, even during recovery.
        return false
      }
      const candidates = knownKeyboards.length ? knownKeyboards : ports
      // Try USB devices before virtual serial ports.
      candidates.sort((a, b) => Number(Boolean(b.vendorId)) - Number(Boolean(a.vendorId)))
      for (const candidate of candidates) {
        const port = new SerialPort({ path: candidate.path, baudRate: 115200, autoOpen: false })
        const disconnect = () => {
          if (this.port !== port) return
          this.screenReadback?.close()
          this.port = undefined
          this.screenReadback = undefined
          this.waitState = false
          if (port.isOpen) port.close(() => {})
        }
        port.on('error', disconnect)
        port.on('close', disconnect)

        const opened = await new Promise<boolean>((resolve) => port.open(error => resolve(!error)))
        if (!opened) continue

        let reply = Buffer.alloc(0)
        const collectHandshake = (chunk: Buffer) => {
          reply = Buffer.concat([reply, chunk]).subarray(-32)
        }
        port.on('data', collectHandshake)
        const sent = await this.writePort(port, HANDSHAKE)
        if (sent) await new Promise((resolve) => setTimeout(resolve, 500))
        port.off('data', collectHandshake)

        if (!port.isOpen || !reply.includes(HANDSHAKE)) {
          if (port.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()))
          continue
        }

        this.port = port
        if (reply.includes(READBACK_CAPABILITY)) {
          this.screenReadback = new ScreenReadback((data) => this.writePort(port, data))
        }
        port.on('data', (chunk: Buffer) => {
          if (this.port !== port) return
          if (this.screenReadback?.busy) this.screenReadback.accept(chunk)
          else if (chunk[0] === 0x77) this.waitState = true
        })
        console.info('connect success', candidate.path)
        return true
      }
    } catch (error) {
      console.error(error)
    }
    return false
  }

  static async readDeviceScreens(knownGeneration?: number): Promise<DeviceScreens> {
    if (!this.port?.isOpen) return { state: 'disconnected' }
    if (!this.screenReadback) return { state: 'unsupported' }
    return this.screenReadback.read(knownGeneration)
  }

  static async sendData(data: string | Uint8Array): Promise<boolean> {
    if (!this.port?.isOpen || this.screenReadback?.busy) return false
    return this.writePort(this.port, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
  }

  private static writePort(port: SerialPortInstance, data: Buffer): Promise<boolean> {
    if (!port.isOpen) return Promise.resolve(false)
    return new Promise((resolve) => {
      port.write(data, (error) => {
        if (error) {
          resolve(false)
          return
        }
        port.drain((error) => resolve(!error))
      })
    })
  }

  static async waitSign(): Promise<boolean> {
    while (this.port?.isOpen) {
      if (this.waitState) {
        this.waitState = false
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return false
  }
}
