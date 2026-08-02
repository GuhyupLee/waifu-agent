import { describe, expect, it } from 'vitest'
import { DiscordBot, clampRemotePermission } from '../src/main/discord/bot'
import { splitMessage } from '../src/main/discord/gateway'
import type { WaifuConfig } from '../src/shared/protocol'

const cfg = (over: Partial<WaifuConfig['discord']> = {}): WaifuConfig['discord'] => ({
  enabled: true,
  token: 'tok',
  allowedUserIds: ['123'],
  maxPermission: 'guarded',
  ...over
})

describe('DiscordBot.check — 켜지지 않는 쪽으로 기운다', () => {
  it('제대로 설정되면 켜진다', () => {
    expect(DiscordBot.check(cfg()).ok).toBe(true)
  })

  it('꺼져 있으면 시작하지 않는다', () => {
    expect(DiscordBot.check(cfg({ enabled: false })).ok).toBe(false)
  })

  it('토큰이 없으면 시작하지 않는다', () => {
    expect(DiscordBot.check(cfg({ token: '   ' })).ok).toBe(false)
  })

  it('허용 목록이 비면 시작하지 않는다', () => {
    // 비어 있는데 켜는 건 "아무나 들어와도 된다" 는 뜻이 된다.
    // 여기서 '전부 허용' 으로 해석하면 봇 링크를 아는 누구나 PC 를 조종한다.
    const r = DiscordBot.check(cfg({ allowedUserIds: [] }))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('허용된 사용자')
  })
})

describe('clampRemotePermission — 원격은 더 강해질 수 없다', () => {
  it('맡겨두기로 쓰고 있어도 원격은 상한까지 내려간다', () => {
    // 눈앞에 없는 사람이 무제한 자동 실행을 시키면 안 된다.
    expect(clampRemotePermission('auto', 'guarded')).toBe('guarded')
  })

  it('상한이 읽기전용이면 무엇이든 읽기전용이다', () => {
    expect(clampRemotePermission('auto', 'readonly')).toBe('readonly')
    expect(clampRemotePermission('guarded', 'readonly')).toBe('readonly')
  })

  it('이미 읽기전용이면 상한이 높아도 올라가지 않는다', () => {
    // 상한은 천장이지 바닥이 아니다.
    expect(clampRemotePermission('readonly', 'guarded')).toBe('readonly')
  })

  it('도와주기는 그대로 유지된다', () => {
    expect(clampRemotePermission('guarded', 'guarded')).toBe('guarded')
  })
})

describe('splitMessage — Discord 2000자 상한', () => {
  it('짧으면 그대로 하나다', () => {
    expect(splitMessage('안녕')).toEqual(['안녕'])
  })

  it('빈 문자열도 뭔가는 보낸다', () => {
    // 빈 본문을 보내면 Discord 가 400 을 준다.
    expect(splitMessage('')).toEqual(['(빈 응답)'])
  })

  it('줄 단위로 끊는다', () => {
    const text = Array.from({ length: 100 }, (_, i) => `줄 ${i} `.repeat(10)).join('\n')
    const parts = splitMessage(text, 200)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200)
    // 내용이 유실되면 안 된다.
    expect(parts.join('\n')).toBe(text)
  })

  it('한 줄이 상한을 넘으면 그 줄만 강제로 자른다', () => {
    const parts = splitMessage('x'.repeat(500), 100)
    expect(parts).toHaveLength(5)
    expect(parts.every((p) => p.length <= 100)).toBe(true)
  })
})
