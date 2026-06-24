import { describe, expect, it } from 'vitest'
import { extOf, sniff } from '../../src/renderer/src/lib/magic'

const b = (...n: number[]): Uint8Array => new Uint8Array(n)

describe('sniff (매직바이트)', () => {
  it('PDF "%PDF" 를 인식한다', () => {
    expect(sniff(b(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)).isPdf).toBe(true)
  })

  it('ZIP(PK) 컨테이너를 인식한다 (ooxml/hwpx)', () => {
    expect(sniff(b(0x50, 0x4b, 0x03, 0x04)).isZip).toBe(true)
    expect(sniff(b(0x50, 0x4b, 0x05, 0x06)).isZip).toBe(true)
  })

  it('OLE2 복합문서를 인식한다 (hwp5/구형 오피스)', () => {
    expect(sniff(b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)).isOle).toBe(true)
  })

  it('너무 짧은 버퍼에서도 안전하게 false 를 반환한다', () => {
    const m = sniff(b(0x25))
    expect(m).toEqual({ isPdf: false, isZip: false, isOle: false })
  })

  it('빈 버퍼도 처리한다', () => {
    expect(() => sniff(b())).not.toThrow()
  })
})

describe('extOf (확장자 추출)', () => {
  it('대문자 확장자를 소문자로 정규화한다', () => {
    expect(extOf('보고서.HWP')).toBe('.hwp')
  })
  it('확장자가 없으면 빈 문자열', () => {
    expect(extOf('noext')).toBe('')
  })
  it('점으로 끝나면 빈 문자열', () => {
    expect(extOf('foo.')).toBe('')
  })
  it('여러 점이 있어도 마지막만', () => {
    expect(extOf('a.b.c.pptx')).toBe('.pptx')
  })
})
