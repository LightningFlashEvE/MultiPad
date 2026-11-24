export type PetAction = 'idle' | 'walk' | 'sleep' | 'eat' | 'react' | 'run' | 'flee' | 'blink' |
  'daydream' | 'trip_angry' | 'gaze_owner'

function rect(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

function pixelCircle(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number) {
  for (let dy = -radius; dy <= radius; dy++) {
    const half = Math.floor(Math.sqrt(radius * radius - dy * dy))
    rect(ctx, color, x - half, y + dy, half * 2 + 1, 1)
  }
}

function hill(ctx: CanvasRenderingContext2D, color: string, peaks: number[][]) {
  for (let index = 1; index < peaks.length; index++) {
    const [x, y] = peaks[index - 1]
    const [nextX, nextY] = peaks[index]
    for (let column = x; column < nextX; column += 2) {
      const top = Math.round((y + (nextY - y) * (column - x) / (nextX - x)) / 2) * 2
      rect(ctx, color, column, top, 2, 142 - top)
    }
  }
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  rect(ctx, '#506e66', x - 2, y, 4, 31)
  pixelCircle(ctx, color, x - 7, y + 6, 11)
  pixelCircle(ctx, color, x + 8, y + 5, 12)
  pixelCircle(ctx, color, x + 1, y - 5, 15)
  rect(ctx, '#83a37a', x - 7, y - 10, 6, 2)
  rect(ctx, '#83a37a', x - 9, y - 8, 2, 4)
}

export function drawGarden(ctx: CanvasRenderingContext2D) {
  rect(ctx, '#f6c19e', 0, 0, 320, 172)
  rect(ctx, '#efac99', 0, 0, 320, 23)
  rect(ctx, '#f3b49b', 0, 23, 320, 21)
  rect(ctx, '#f9cda4', 0, 66, 320, 33)
  pixelCircle(ctx, '#ffe7b1', 237, 54, 21)
  for (const [x, y, width] of [[23, 38, 40], [99, 60, 45], [279, 28, 27]]) {
    rect(ctx, '#ffdbb2', x, y, width, 3)
    rect(ctx, '#ffdbb2', x + 8, y - 3, width - 19, 3)
    rect(ctx, '#fbe0b7', x + 5, y + 3, width - 9, 2)
  }
  hill(ctx, '#d39291', [[0, 105], [22, 96], [44, 80], [62, 83], [104, 100], [135, 98], [168, 79], [185, 82], [219, 105], [270, 93], [297, 78], [320, 92]])
  hill(ctx, '#af8291', [[0, 112], [39, 103], [70, 107], [105, 122], [150, 113], [174, 106], [196, 108], [227, 120], [261, 108], [295, 102], [320, 109]])
  hill(ctx, '#858f87', [[0, 128], [43, 120], [85, 126], [140, 129], [179, 120], [217, 128], [280, 117], [320, 124]])
  tree(ctx, 22, 110, '#668c76')
  tree(ctx, 294, 108, '#628772')
  rect(ctx, '#799866', 0, 138, 320, 34)
  rect(ctx, '#95a978', 0, 140, 320, 3)
  rect(ctx, '#678460', 0, 159, 320, 13)
  rect(ctx, '#5a7459', 0, 169, 320, 3)
  for (const [x, y] of [[10, 147], [31, 156], [60, 150], [96, 162], [129, 150], [160, 155], [198, 151], [222, 163], [246, 156], [281, 148], [305, 160]]) {
    rect(ctx, '#527057', x, y, 2, 4)
    rect(ctx, '#527057', x + 2, y + 2, 3, 2)
    rect(ctx, '#a4b47c', x + 6, y + 4, 4, 1)
  }
  for (const [x, y] of [[37, 146], [71, 155], [176, 150], [251, 146], [290, 155]]) {
    rect(ctx, '#526d55', x, y, 2, 5)
    rect(ctx, '#ffd39e', x - 2, y - 2, 6, 3)
    rect(ctx, '#f7a78a', x, y - 3, 2, 4)
  }
}

export function drawToyFactory(ctx: CanvasRenderingContext2D) {
  // Painted brick, steel rafters and a clerestory window above the assembly line.
  rect(ctx, '#b7bbb1', 0, 0, 320, 172)
  for (let y = 22; y < 116; y += 16) {
    rect(ctx, '#a9afa6', 0, y, 320, 1)
    for (let x = ((y - 22) % 32 === 0 ? 12 : 34); x < 320; x += 44)
      rect(ctx, '#a9afa6', x, y + 1, 1, 15)
  }
  rect(ctx, '#556876', 0, 0, 320, 8)
  rect(ctx, '#76848a', 0, 8, 320, 3)
  for (const x of [8, 160, 305]) {
    rect(ctx, '#78888a', x, 11, 5, 105)
    rect(ctx, '#8f9d98', x + 4, 11, 2, 105)
  }
  rect(ctx, '#778888', 18, 24, 113, 52)
  rect(ctx, '#596e76', 18, 22, 111, 52)
  rect(ctx, '#8ebbc2', 22, 26, 103, 44)
  rect(ctx, '#c3d7c6', 22, 52, 103, 18)
  for (const x of [28, 76, 99]) {
    rect(ctx, '#d5e0d2', x, 38, 14, 2)
    rect(ctx, '#d5e0d2', x + 4, 36, 6, 2)
  }
  for (const x of [47, 74, 101]) rect(ctx, '#71878a', x, 26, 3, 44)
  rect(ctx, '#71878a', 22, 47, 103, 3)
  rect(ctx, '#e0d7ba', 15, 73, 118, 4)
  // Pendant lamps and a short belt carrying a wooden train and blocks.
  for (const x of [145, 196, 273]) {
    rect(ctx, '#667b78', x, 10, 2, 18)
    rect(ctx, '#48786f', x - 5, 27, 12, 3)
    rect(ctx, '#48786f', x - 9, 30, 20, 4)
    rect(ctx, '#f6d592', x - 8, 34, 18, 2)
  }
  rect(ctx, '#987e71', 0, 115, 320, 8)
  rect(ctx, '#c4ac8f', 0, 123, 320, 49)
  rect(ctx, '#d2b998', 0, 124, 320, 3)
  for (const y of [140, 156, 169]) {
    rect(ctx, '#b49a82', 0, y, 320, 1)
    for (let x = y % 3 * 38 + 15; x < 320; x += 91) rect(ctx, '#b49a82', x, y + 1, 1, 13)
  }
  rect(ctx, '#65787b', 12, 98, 142, 9)
  rect(ctx, '#3f5866', 15, 100, 136, 5)
  for (let x = 18; x < 150; x += 12) rect(ctx, '#a7b4a8', x, 101, 3, 2)
  for (const x of [21, 132]) {
    rect(ctx, '#617679', x, 107, 5, 16)
    rect(ctx, '#505e64', x - 3, 122, 11, 2)
  }
  rect(ctx, '#ae6359', 33, 88, 23, 6)
  rect(ctx, '#e8c27c', 34, 79, 11, 9)
  rect(ctx, '#668c92', 37, 81, 5, 6)
  rect(ctx, '#698d85', 47, 84, 8, 4)
  rect(ctx, '#ac6b5d', 51, 79, 3, 5)
  pixelCircle(ctx, '#475d66', 38, 95, 3)
  pixelCircle(ctx, '#475d66', 51, 95, 3)
  for (const [x, y, paint] of [[91, 87, '#daa36f'], [103, 87, '#79a59a'], [98, 76, '#c98677']] as const) {
    rect(ctx, paint, x, y, 11, 11)
    rect(ctx, '#eed2a0', x + 2, y + 2, 5, 1)
  }

  // The door is centred on the firmware's interaction point (246, 139).
  rect(ctx, '#a78c78', 211, 139, 72, 4)
  rect(ctx, '#80584f', 211, 88, 70, 51)
  rect(ctx, '#cc956a', 215, 90, 62, 46)
  for (const x of [220, 230, 242, 254, 266]) rect(ctx, '#bb825f', x, 92, 1, 42)
  for (let row = 0; row < 10; row++) {
    const x = 242 - row * 4
    rect(ctx, row < 2 ? '#93645c' : '#af7062', x, 67 + row * 2, 8 + row * 8, 2)
  }
  rect(ctx, '#744e4d', 204, 87, 84, 4)
  rect(ctx, '#e2ac79', 210, 91, 72, 3)
  rect(ctx, '#966650', 233, 98, 26, 4)
  rect(ctx, '#966650', 227, 102, 38, 34)
  rect(ctx, '#695661', 232, 105, 28, 30)
  rect(ctx, '#695661', 229, 111, 34, 23)
  rect(ctx, '#a47d71', 230, 130, 32, 6)
  rect(ctx, '#deb178', 228, 133, 36, 3)
  drawHutchStraw(ctx)
}

export function drawHutchStraw(ctx: CanvasRenderingContext2D) {
  rect(ctx, '#efbc75', 226, 136, 40, 2)
  rect(ctx, '#a66550', 226, 138, 40, 2)
}

export function drawPetEffects(
  ctx: CanvasRenderingContext2D, x: number, direction: number,
  action: PetAction, elapsed: number, foreground: boolean
) {
  if (!foreground) {
    rect(ctx, '#587955', x - 23, 138, 46, 3)
    rect(ctx, '#587955', x - 18, 141, 36, 1)
    if (action === 'eat') {
      const bowl = x + direction * 29 - 6
      rect(ctx, '#5b4551', bowl, 134, 12, 5)
      rect(ctx, '#f6b886', bowl + 1, 135, 10, 3)
      rect(ctx, '#68444b', bowl + 5, 132, 4, 2)
    }
    return
  }

  if (action === 'sleep') {
    const lift = Math.floor((elapsed % 1500) / 140)
    const signX = x + direction * 25
    rect(ctx, '#fff0c6', signX, 102 - lift, 6, 2)
    rect(ctx, '#fff0c6', signX + 2, 104 - lift, 2, 2)
    rect(ctx, '#fff0c6', signX, 106 - lift, 6, 2)
  } else if (action === 'react' || action === 'eat') {
    const starX = x + direction * 23
    const starY = (action === 'react' ? 82 : 103) - Math.floor(elapsed / 90) % 5
    rect(ctx, '#fff3c9', starX + 2, starY, 2, 8)
    rect(ctx, '#fff3c9', starX - 1, starY + 3, 8, 2)
  }
}
