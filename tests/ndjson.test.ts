import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import { NdjsonReader, parseLines } from '../src/main/backends/ndjson'

describe('NdjsonReader', () => {
  it('한 청크에 들어온 여러 줄을 모두 돌려준다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"a":1}\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}'])
    expect(r.flush()).toEqual([])
  })

  it('청크 경계에서 잘린 줄을 이어 붙인다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"type":"assis')).toEqual([])
    expect(r.push('tant"}\n')).toEqual(['{"type":"assistant"}'])
  })

  it('한 줄이 세 청크에 걸쳐도 복원한다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"te')).toEqual([])
    expect(r.push('xt":"안녕')).toEqual([])
    expect(r.push('하세요"}\n')).toEqual(['{"text":"안녕하세요"}'])
  })

  it('UTF-8 한글 바이트 한가운데서 잘려도 Node 디코더와 함께 복원한다', () => {
    const r = new NdjsonReader()
    const decoder = new StringDecoder('utf8')
    const bytes = Buffer.from('{"text":"안녕"}\n', 'utf8')
    const split = bytes.indexOf(Buffer.from('녕', 'utf8')) + 1

    expect(r.push(decoder.write(bytes.subarray(0, split)))).toEqual([])
    expect(r.push(decoder.end(bytes.subarray(split)))).toEqual(['{"text":"안녕"}'])
  })

  it('개행 없이 끝난 마지막 줄을 flush 로 회수한다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"a":1}\n{"a":2}')).toEqual(['{"a":1}'])
    expect(r.flush()).toEqual(['{"a":2}'])
  })

  it('flush 후 버퍼가 비어 재호출해도 중복이 없다', () => {
    const r = new NdjsonReader()
    r.push('{"a":1}')
    expect(r.flush()).toEqual(['{"a":1}'])
    expect(r.flush()).toEqual([])
  })

  it('CRLF 를 벗겨낸다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"a":1}\r\n{"a":2}\r\n')).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('빈 줄을 버린다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"a":1}\n\n\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('청크가 개행 하나만 담고 있어도 깨지지 않는다', () => {
    const r = new NdjsonReader()
    expect(r.push('{"a":1}')).toEqual([])
    expect(r.push('\n')).toEqual(['{"a":1}'])
    expect(r.flush()).toEqual([])
  })
})

describe('parseLines', () => {
  it('깨진 줄은 건너뛰고 나머지를 살린다', () => {
    const bad: string[] = []
    const out = parseLines(['{"a":1}', 'not json', '{"a":2}'], (l) => bad.push(l))
    expect(out).toEqual([{ a: 1 }, { a: 2 }])
    expect(bad).toEqual(['not json'])
  })
})
