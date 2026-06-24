import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readDoc, ALLOWED_EXT, MAX_BYTES } from '../../src/main/fileService'

const dir = await mkdtemp(join(tmpdir(), 'ssgkimchi-test-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

async function makeFile(name: string, content: Uint8Array | string): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, content)
  return p
}

describe('readDoc (에러 테스트 포함)', () => {
  it('정상 PDF 를 읽어 OpenedFile 로 돌려준다', async () => {
    const p = await makeFile('정상.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))
    const doc = await readDoc(p)
    expect(doc.name).toBe('정상.pdf')
    expect(doc.ext).toBe('.pdf')
    expect(doc.bytes.byteLength).toBe(6)
    // 독립 ArrayBuffer 인지 (SharedArrayBuffer 아님)
    expect(doc.bytes).toBeInstanceOf(ArrayBuffer)
  })

  it('빈 파일은 거부한다', async () => {
    const p = await makeFile('빈.hwp', '')
    await expect(readDoc(p)).rejects.toThrow('빈 파일')
  })

  it('지원하지 않는 확장자는 거부한다', async () => {
    const p = await makeFile('메모.txt', 'hello')
    await expect(readDoc(p)).rejects.toThrow('지원하지 않는 형식')
  })

  it('확장자가 없으면 거부한다', async () => {
    const p = await makeFile('noext', 'data')
    await expect(readDoc(p)).rejects.toThrow('지원하지 않는 형식')
  })

  it('화이트리스트와 상한이 노출되어 있다', () => {
    expect(ALLOWED_EXT.has('.hwpx')).toBe(true)
    expect(ALLOWED_EXT.has('.exe')).toBe(false)
    expect(MAX_BYTES).toBeGreaterThan(0)
  })
})
