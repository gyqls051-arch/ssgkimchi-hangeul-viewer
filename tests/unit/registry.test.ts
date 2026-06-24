import { describe, expect, it } from 'vitest'
import { resolveViewer } from '../../src/renderer/src/viewers/registry'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const JUNK = new Uint8Array([0x00, 0x01, 0x02, 0x03])

describe('resolveViewer (포맷 라우팅)', () => {
  it('확장자로 한글(hwp/hwpx)을 라우팅한다', () => {
    expect(resolveViewer('문서.hwp', OLE).id).toBe('hwp')
    expect(resolveViewer('문서.hwpx', ZIP).id).toBe('hwp')
  })

  it('확장자로 오피스 포맷을 라우팅한다', () => {
    expect(resolveViewer('a.docx', ZIP).id).toBe('docx')
    expect(resolveViewer('a.xlsx', ZIP).id).toBe('xlsx')
    expect(resolveViewer('a.pptx', ZIP).id).toBe('pptx')
  })

  it('PDF는 매직바이트가 확장자보다 우선한다 (확장자 위조 방어)', () => {
    // .docx 로 위장했지만 실제 내용은 PDF → pdf 뷰어로
    expect(resolveViewer('악성.docx', PDF).id).toBe('pdf')
  })

  it('미지원 확장자는 unsupported', () => {
    expect(resolveViewer('메모.txt', JUNK).id).toBe('unsupported')
  })

  it('확장자 없는 OLE는 구형 오피스 가능성 때문에 보수적으로 unsupported', () => {
    expect(resolveViewer('noext', OLE).id).toBe('unsupported')
  })

  it('대문자 확장자도 처리한다', () => {
    expect(resolveViewer('REPORT.PDF', PDF).id).toBe('pdf')
    expect(resolveViewer('REPORT.HWPX', ZIP).id).toBe('hwp')
  })
})
