#!/usr/bin/env node
/**
 * 트레이 아이콘 PNG 를 만든다.
 *
 * 왜 파일을 만들어 두는가: `resources/tray.png` 가 없으면 트레이가 아예 생기지
 * 않고, 그러면 "창을 닫아도 트레이에 남기" 설정이 앱을 되살릴 수 없는 함정이 된다.
 * 실제로 그 상태로 프로세스가 살아남아 개발 서버 포트를 붙잡고 있었다.
 *
 * 왜 생성하는가: 바이너리 에셋을 손으로 넣으면 출처와 라이선스를 따로 기록해야
 * 한다. 이 아이콘은 이 저장소가 만든 것이고, 코드를 읽으면 무엇이 그려지는지
 * 알 수 있다. 사용자가 자기 그림으로 덮어써도 된다.
 *
 * 의존성 없이 zlib 만으로 PNG 를 조립한다.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 32

/** 패널 UI 의 강조색과 같은 계열. 트레이에서도 같은 앱으로 읽혀야 한다. */
const ACCENT = [0x6d, 0x5e, 0xf0]
const LIGHT = [0xc9, 0xc2, 0xff]

function crc32(buffer) {
  let crc = ~0
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * 아이콘 모양: 둥근 머리 실루엣과 한쪽으로 치우친 밝은 점.
 *
 * 16px 로 줄어들어도 알아볼 수 있어야 해서 형태는 원 하나로 둔다. 안티에일리어싱은
 * 경계에서 알파를 부드럽게 깎아 만든다 — 계단이 보이면 트레이에서 지저분하다.
 */
function pixel(x, y) {
  const cx = (SIZE - 1) / 2
  const cy = (SIZE - 1) / 2
  const dx = x - cx
  const dy = y - cy
  const distance = Math.hypot(dx, dy)

  const radius = SIZE / 2 - 1.5
  // 경계에서 1px 에 걸쳐 알파를 깎는다.
  const alpha = Math.max(0, Math.min(1, radius - distance + 0.5))
  if (alpha <= 0) return [0, 0, 0, 0]

  // 오른쪽 위에 밝은 점 하나. 시선처럼 보여 방향감이 생긴다.
  const highlight = Math.hypot(dx - SIZE * 0.16, dy + SIZE * 0.14)
  const glow = Math.max(0, Math.min(1, SIZE * 0.13 - highlight + 0.5))

  const color = [
    Math.round(ACCENT[0] + (LIGHT[0] - ACCENT[0]) * glow),
    Math.round(ACCENT[1] + (LIGHT[1] - ACCENT[1]) * glow),
    Math.round(ACCENT[2] + (LIGHT[2] - ACCENT[2]) * glow)
  ]
  return [color[0], color[1], color[2], Math.round(alpha * 255)]
}

function build() {
  // 각 줄 앞에 필터 바이트 0(None)이 붙는다. PNG 스캔라인 형식이다.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let offset = 0
  for (let y = 0; y < SIZE; y++) {
    raw[offset++] = 0
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(repoRoot, 'resources', 'tray.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, build())
process.stdout.write(`${out} (${SIZE}x${SIZE})\n`)
