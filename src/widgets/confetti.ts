// Confetti for the star charts. Every star gets a small one: the two corner
// cannons, ~4 s. Finishing a chart gets the party, meant to be remembered
// (~7 s); after either, everything is torn down:
//   0.0 s  two cannons fire from the bottom corners
//   0.9 s  a white flash, the board shakes, star-shaped confetti bursts
//          from the middle, and a giant "<NAME> DID IT!" bounces in
//   2.4 s  confetti rains from the top while the banner bobs
//   ~6 s   the banner zooms off, the last confetti fades
//
// Built for the frame's weak GPU and 1 GB of RAM: WebGL1, one draw call of
// a few hundred points a frame (each point is a tumbling paper rectangle cut
// out in the fragment shader), physics on the CPU. The canvas and its GL
// context exist only while it runs, and the context is released after, so
// nothing lingers for the weeks the page stays up. The banner, flash and
// shake are plain DOM with transform/opacity animations (stars.css). Without
// WebGL there's no confetti, but the banner still shows.

const W = 1280
const H = 800
// The two sizes: a star, and a finished chart.
const SIZES = {
  star: { cannon: 140, stars: false, burst: 0, rain: 0, life: 4200, fade: 1000 },
  goal: { cannon: 170, stars: true, burst: 170, rain: 220, life: 7000, fade: 1200 },
}
type Size = (typeof SIZES)[keyof typeof SIZES]
const BURST_AT = 900
const RAIN_AT = 2400
const GRAVITY = 1500 // px/s²
const BRIGHTS = ['#ffc45c', '#00a36c', '#2f7de1', '#e5261e', '#ff9500', '#db2777', '#8b5cf6']
// x, y, size, angle, flip, shape, r, g, b, a
const STRIDE = 10

const VERT = `
attribute vec2 a_pos;
attribute float a_size;
attribute float a_angle;
attribute float a_flip;
attribute float a_shape;
attribute vec4 a_color;
uniform vec2 u_res;
varying float v_angle;
varying float v_flip;
varying float v_shape;
varying vec4 v_color;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = a_size;
  v_angle = a_angle;
  v_flip = a_flip;
  v_shape = a_shape;
  v_color = a_color;
}`

// Shape 0: a rectangle inside the point sprite, rotated, its height squashed
// by the tumble (flip = cos of the tumble angle). Shape 1: a five-pointed
// star, squashed the same way. The back face is a little darker.
const FRAG = `
precision mediump float;
varying float v_angle;
varying float v_flip;
varying float v_shape;
varying vec4 v_color;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float s = sin(v_angle), c = cos(v_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  if (v_shape < 0.5) {
    if (abs(p.x) > 0.42 || abs(p.y) > 0.04 + 0.2 * abs(v_flip)) discard;
  } else {
    // A five-pointed star (signed distance, after Inigo Quilez's sdStar5),
    // point up; the tumble squashes it sideways.
    p.x /= max(0.25, abs(v_flip));
    p.y = -p.y;
    vec2 k1 = vec2(0.809016994, -0.587785252);
    vec2 k2 = vec2(-0.809016994, -0.587785252);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= 0.46;
    vec2 ba = 0.42 * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, 0.46);
    if (length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y) > 0.0) discard;
  }
  float shade = v_flip < 0.0 ? 0.78 : 1.0;
  gl_FragColor = vec4(v_color.rgb * shade * v_color.a, v_color.a);
}`

interface Bit {
  x: number; y: number; vx: number; vy: number
  size: number; angle: number; spin: number; tumble: number; tumbleSpeed: number
  shape: number // 0 paper, 1 star
  drag: number // per second, on velocity: high floats (the rain), low flies
  r: number; g: number; b: number
  delay: number // ms after the start before it appears
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function shader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
}

function makeBits(color: string, z: Size): Bit[] {
  const kid = /^#[0-9a-fA-F]{6}$/.test(color) ? color : BRIGHTS[2]
  const pick = (i: number) => rgb(i % 3 === 0 ? kid : BRIGHTS[Math.floor(Math.random() * BRIGHTS.length)])
  const bits: Bit[] = []
  const add = (b: Omit<Bit, 'r' | 'g' | 'b' | 'angle' | 'spin' | 'tumble' | 'tumbleSpeed'>, i: number) => {
    const [r, g, bl] = pick(i)
    bits.push({
      ...b, r, g, b: bl,
      angle: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 10,
      tumble: Math.random() * Math.PI * 2, tumbleSpeed: 6 + Math.random() * 8,
    })
  }
  // Cannons: up and inward, 55–80° from the floor; a third in the kid's colour.
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < z.cannon; i++) {
      const a = (55 + Math.random() * 25) * Math.PI / 180
      const speed = 1100 + Math.random() * 750
      add({
        x: side ? W + 10 : -10, y: H + 10,
        vx: Math.cos(a) * speed * (side ? -1 : 1), vy: -Math.sin(a) * speed,
        size: 14 + Math.random() * 14, shape: z.stars && i % 7 === 0 ? 1 : 0, drag: 1.1,
        delay: Math.random() * 350,
      }, i)
    }
  }
  // Burst: stars out of the middle in every direction, mostly upward.
  for (let i = 0; i < z.burst; i++) {
    const a = Math.random() * Math.PI * 2
    const speed = 500 + Math.random() * 1000
    add({
      x: W / 2, y: H * 0.45,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 450,
      size: 22 + Math.random() * 20, shape: i % 3 === 2 ? 0 : 1, drag: 1.6,
      delay: BURST_AT + Math.random() * 120,
    }, i)
  }
  // Rain: drifts down from above the whole width, slowed by a lot of drag.
  for (let i = 0; i < z.rain; i++) {
    add({
      x: Math.random() * W, y: -30 - Math.random() * 60,
      vx: (Math.random() - 0.5) * 120, vy: 100 + Math.random() * 200,
      size: 14 + Math.random() * 14, shape: i % 5 === 0 ? 1 : 0, drag: 3.6,
      delay: RAIN_AT + Math.random() * 2200,
    }, i)
  }
  return bits
}

/** The banner, flash and shake: DOM, removed when the party ends. */
function stageShow(host: HTMLElement, who: { name: string; color: string; goal: string; target: number }): () => void {
  const color = /^#[0-9a-fA-F]{6}$/.test(who.color) ? who.color : BRIGHTS[2]
  const flash = document.createElement('div')
  flash.className = 'cele-flash'
  const banner = document.createElement('div')
  banner.className = 'cele'
  banner.style.setProperty('--c', color)
  const inner = document.createElement('div')
  inner.className = 'cele-in'
  const name = document.createElement('div')
  name.className = 'cele-name'
  name.textContent = who.name + ' did it!'
  // 150px fits about eleven capitals across the stage; longer names shrink.
  name.style.fontSize = Math.round(Math.min(150, 1150 / (name.textContent.length * 0.68))) + 'px'
  const stars = document.createElement('div')
  stars.className = 'cele-stars'
  stars.textContent = '★★★★★★★★★★'.slice(0, Math.max(1, Math.min(10, who.target)))
  const goal = document.createElement('div')
  goal.className = 'cele-goal'
  goal.textContent = who.goal
  inner.appendChild(stars)
  inner.appendChild(name)
  inner.appendChild(goal)
  banner.appendChild(inner)
  host.appendChild(flash)
  host.appendChild(banner)
  // The board shakes with the burst. Its own transform is the burn-in shift,
  // which the animation overrides only while it runs.
  const board = document.getElementById('board')
  const shake = setTimeout(() => { if (board) board.classList.add('is-shaking') }, BURST_AT)
  const unshake = setTimeout(() => { if (board) board.classList.remove('is-shaking') }, BURST_AT + 700)
  return () => {
    clearTimeout(shake)
    clearTimeout(unshake)
    if (board) board.classList.remove('is-shaking')
    if (flash.parentNode) flash.parentNode.removeChild(flash)
    if (banner.parentNode) banner.parentNode.removeChild(banner)
  }
}

// The one running now. A finished chart cuts in on a star's confetti (the
// last star can come seconds after the one before); anything else waits.
let current: { kind: keyof typeof SIZES; stop: () => void } | null = null

/** Confetti over `host` (the 1280×800 stage): `star` for a star, `goal`
 * (the party, with the banner) for a finished chart. One at a time. */
export function celebrate(
  host: HTMLElement | null,
  kind: keyof typeof SIZES,
  who: { name: string; color: string; goal: string; target: number },
): void {
  if (!host || typeof requestAnimationFrame === 'undefined') return
  if (current) {
    if (kind === 'goal' && current.kind === 'star') current.stop()
    else return
  }
  const z = SIZES[kind]
  const LIFE_MS = z.life, FADE_MS = z.fade
  const endShow = kind === 'goal' ? stageShow(host, who) : () => {}
  const me = { kind, stop: () => {} }
  current = me
  const release = () => { if (current === me) current = null }
  // Without WebGL this ends the banner; with it, done() below does.
  const endAt = setTimeout(() => { release(); endShow() }, LIFE_MS)
  me.stop = () => { clearTimeout(endAt); release(); endShow() }
  const fail = () => { /* no WebGL: the banner alone, ended by endAt */ }
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.className = 'confetti'
  canvas.setAttribute('aria-hidden', 'true')
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false })
  if (!gl) return fail()
  const vs = shader(gl, gl.VERTEX_SHADER, VERT)
  const fs = shader(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return fail()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail()
  gl.useProgram(prog)
  gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), W, H)

  const bits = makeBits(who.color, z)
  const data = new Float32Array(bits.length * STRIDE)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
  const F = 4
  const attr = (name: string, size: number, offset: number) => {
    const loc = gl.getAttribLocation(prog, name)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * F, offset * F)
  }
  attr('a_pos', 2, 0)
  attr('a_size', 1, 2)
  attr('a_angle', 1, 3)
  attr('a_flip', 1, 4)
  attr('a_shape', 1, 5)
  attr('a_color', 4, 6)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.viewport(0, 0, W, H)
  gl.clearColor(0, 0, 0, 0)

  host.appendChild(canvas)
  // Stopping removes the canvas; the next frame sees that and cleans up.
  me.stop = () => { release(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas) }
  const start = performance.now()
  let last = start

  const done = () => {
    clearTimeout(endAt)
    release()
    endShow()
    const lose = gl.getExtension('WEBGL_lose_context')
    gl.deleteBuffer(buf)
    gl.deleteProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (lose) lose.loseContext()
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
  }

  const frame = (now: number) => {
    const t = now - start
    if (t >= LIFE_MS || !canvas.isConnected) { done(); return }
    // Clamp the step: a stalled frame on the slow CPU mustn't fling paper.
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const alpha = t > LIFE_MS - FADE_MS ? (LIFE_MS - t) / FADE_MS : 1
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i]
      const o = i * STRIDE
      const live = t >= b.delay
      if (live) {
        const drag = Math.max(0, 1 - b.drag * dt)
        b.vy += GRAVITY * dt
        b.vx *= drag
        b.vy *= drag
        // Paper flutters: a little sideways sway as it falls.
        b.x += (b.vx + Math.sin(b.tumble) * 40) * dt
        b.y += b.vy * dt
        b.angle += b.spin * dt
        b.tumble += b.tumbleSpeed * dt
      }
      data[o] = b.x
      data[o + 1] = b.y
      data[o + 2] = b.size
      data[o + 3] = b.angle
      data[o + 4] = Math.cos(b.tumble)
      data[o + 5] = b.shape
      data[o + 6] = b.r
      data[o + 7] = b.g
      data[o + 8] = b.b
      data[o + 9] = live ? alpha : 0
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.POINTS, 0, bits.length)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
