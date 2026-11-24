export type PetAction = 'idle' | 'walk' | 'sleep' | 'eat' | 'react'

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
