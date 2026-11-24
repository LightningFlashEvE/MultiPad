export type ScreenContent =
  | { mode: 'time' | 'date' | 'datetime' }
  | { mode: 'text'; text: string }
  | { mode: 'api'; url: string; field: string; label: string; interval: number }

export interface ScreenFrame {
  baseData: string
  buffData: (number | string)[]
  content?: ScreenContent
}

const win = window as any

export async function renderScreenContent(content: ScreenContent, now = new Date()): Promise<string> {
  const twoDigits = (value: number) => String(value).padStart(2, '0')
  const time = `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`
  const date = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
  const weekday = '日一二三四五六'[now.getDay()]
  let lines: string[]
  switch (content.mode) {
    case 'time':
      lines = [time]
      break
    case 'date':
      lines = [date, `星期${weekday}`]
      break
    case 'datetime':
      lines = [time, date]
      break
    case 'text':
      lines = content.text.trim().split(/\r?\n/, 2)
      if (!lines[0]) throw new Error('请输入文字')
      break
    case 'api': {
      const result = await win.myApi.fetchScreenValue(content.url, content.field)
      if (!result.ok) throw new Error(result.error)
      lines = content.label ? [content.label, result.value] : [result.value]
      break
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = 72
  canvas.height = 40
  const context = canvas.getContext('2d')!
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#fff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  lines.forEach((text, index) => {
    const primary = lines.length === 1 || (content.mode === 'api' ? index === 1 : index === 0)
    const maxSize = primary ? (lines.length === 1 ? 23 : 18) : 11
    const y = lines.length === 1 ? 20 : index === 0 ? 11 : 29
    let size = maxSize
    const setFont = () => { context.font = `bold ${size}px "Microsoft YaHei", sans-serif` }
    setFont()
    while (size > 9 && context.measureText(text).width > 68) {
      size--
      setFont()
    }
    let characters = Array.from(text)
    while (context.measureText(characters.join('')).width > 68) {
      characters.splice(-2, 2, '…')
    }
    context.fillText(characters.join(''), 36, y)
  })
  return canvas.toDataURL('image/png')
}

export async function encodeOled(png: string): Promise<ScreenFrame> {
  const baseData = await win.myApi.resizeImage(72, 40, png, 1)
  const buffData = await win.myApi.generateResultArray(baseData, 120, 1, 2, 0, 0, 1)
  if (buffData.length !== 360) throw new Error('小屏像素数据长度错误')
  return { baseData, buffData }
}
