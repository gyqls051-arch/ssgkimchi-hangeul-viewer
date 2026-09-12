import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { MAX_DOC_BYTES, type OpenedFile } from '../preload/api'

/** 뷰어가 다루는 확장자 화이트리스트 */
export const ALLOWED_EXT = new Set([
  '.pdf',
  '.hwp',
  '.hwpx',
  '.docx',
  '.xlsx',
  '.pptx'
])

const ZIP_EXT = new Set(['.hwpx', '.docx', '.xlsx', '.pptx'])
const ZIP_MAX_ENTRIES = 10_000
const ZIP_MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
const ZIP_MAX_SINGLE_UNCOMPRESSED = 128 * 1024 * 1024
const ZIP_MAX_COMPRESSION_RATIO = 1_000
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const ZIP_AES_EXTRA_ID = 0x9901
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000

/** 메모리 보호용 상한. 초과 시 거부. (렌더러 드롭 폴백과 공유하는 단일 상수) */
export const MAX_BYTES = MAX_DOC_BYTES

/** 경로는 renderer로 보내지 않고 main 내부 최근 파일 저장에만 사용한다. */
export interface OpenedDocument extends OpenedFile {
  canonicalPath: string
}

interface StableStat {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  isFile(): boolean
  isSymbolicLink(): boolean
}

interface ZipEntryRange {
  start: number
  end: number
}

function abortError(): Error {
  const error = new Error('파일 열기가 취소되었습니다.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function sameIdentity(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function sameSnapshot(left: StableStat, right: StableStat): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function ensureZipRange(total: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > total ||
    length > total - offset
  ) {
    throw new Error('손상되었거나 올바르지 않은 ZIP 문서입니다.')
  }
}

function validateZipExtra(view: DataView, offset: number, length: number): void {
  ensureZipRange(view.byteLength, offset, length)
  const end = offset + length
  let cursor = offset

  while (cursor < end) {
    if (end - cursor < 4) throw new Error('손상된 ZIP extra field입니다.')
    const id = view.getUint16(cursor, true)
    const fieldLength = view.getUint16(cursor + 2, true)
    cursor += 4
    if (fieldLength > end - cursor) throw new Error('손상된 ZIP extra field입니다.')
    if (id === ZIP64_EXTRA_ID) throw new Error('Zip64 문서는 지원하지 않습니다.')
    if (id === ZIP_AES_EXTRA_ID) throw new Error('암호화된 문서는 열 수 없습니다.')
    cursor += fieldLength
  }
}

function assertNotEncrypted(flags: number): void {
  if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
    throw new Error('암호화된 문서는 열 수 없습니다.')
  }
}

function bytesEqual(
  bytes: Uint8Array,
  leftOffset: number,
  rightOffset: number,
  length: number
): boolean {
  ensureZipRange(bytes.byteLength, leftOffset, length)
  ensureZipRange(bytes.byteLength, rightOffset, length)
  for (let index = 0; index < length; index += 1) {
    if (bytes[leftOffset + index] !== bytes[rightOffset + index]) return false
  }
  return true
}

/**
 * OOXML/HWPX가 parser에 도달하기 전에 central directory와 각 local header를 교차 검증한다.
 * 압축 해제는 하지 않으며, bomb/Zip64/암호화/multi-disk/구조 불일치를 fail closed 한다.
 */
function validateZipArchive(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (bytes.byteLength < 22) throw new Error('손상되었거나 올바르지 않은 ZIP 문서입니다.')

  const searchStart = Math.max(0, bytes.byteLength - (22 + 0xffff))
  let eocdOffset = -1
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + 22 + commentLength === bytes.byteLength) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('ZIP central directory를 찾을 수 없습니다.')

  if (
    eocdOffset >= 20 &&
    view.getUint32(eocdOffset - 20, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    throw new Error('Zip64 문서는 지원하지 않습니다.')
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true)
  const centralDisk = view.getUint16(eocdOffset + 6, true)
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('분할 ZIP 문서는 지원하지 않습니다.')
  }
  if (
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Zip64 문서는 지원하지 않습니다.')
  }
  if (entryCount === 0 || entryCount > ZIP_MAX_ENTRIES) {
    throw new Error(`ZIP 항목 수가 허용 범위(최대 ${ZIP_MAX_ENTRIES}개)를 벗어났습니다.`)
  }
  ensureZipRange(bytes.byteLength, centralOffset, centralSize)
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error('손상된 ZIP central directory입니다.')
  }

  let cursor = centralOffset
  let totalUncompressed = 0n
  const localRanges: ZipEntryRange[] = []

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    ensureZipRange(bytes.byteLength, cursor, 46)
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('손상된 ZIP central directory 항목입니다.')
    }

    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc32 = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const startDisk = view.getUint16(cursor + 34, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const recordLength = 46 + nameLength + extraLength + commentLength

    ensureZipRange(bytes.byteLength, cursor, recordLength)
    if (cursor + recordLength > eocdOffset) {
      throw new Error('손상된 ZIP central directory 항목입니다.')
    }
    if (nameLength === 0) throw new Error('이름 없는 ZIP 항목은 허용하지 않습니다.')
    assertNotEncrypted(flags)
    if (startDisk !== 0) throw new Error('분할 ZIP 문서는 지원하지 않습니다.')
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error('Zip64 문서는 지원하지 않습니다.')
    }
    validateZipExtra(view, cursor + 46 + nameLength, extraLength)

    if (uncompressedSize > ZIP_MAX_SINGLE_UNCOMPRESSED) {
      throw new Error('ZIP 단일 항목의 압축 해제 크기가 너무 큽니다.')
    }
    totalUncompressed += BigInt(uncompressedSize)
    if (totalUncompressed > BigInt(ZIP_MAX_TOTAL_UNCOMPRESSED)) {
      throw new Error('ZIP 전체 압축 해제 크기가 너무 큽니다.')
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        BigInt(uncompressedSize) > BigInt(compressedSize) * BigInt(ZIP_MAX_COMPRESSION_RATIO))
    ) {
      throw new Error('ZIP 압축률이 안전 한도를 초과했습니다.')
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error('손상된 ZIP 저장 항목입니다.')
    }

    ensureZipRange(bytes.byteLength, localOffset, 30)
    if (localOffset >= centralOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error('손상된 ZIP local header입니다.')
    }
    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localCrc32 = view.getUint32(localOffset + 14, true)
    const localCompressedSize = view.getUint32(localOffset + 18, true)
    const localUncompressedSize = view.getUint32(localOffset + 22, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localHeaderLength = 30 + localNameLength + localExtraLength

    ensureZipRange(bytes.byteLength, localOffset, localHeaderLength)
    assertNotEncrypted(localFlags)
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength) {
      throw new Error('ZIP local/central header가 일치하지 않습니다.')
    }
    if (
      localCompressedSize === 0xffffffff ||
      localUncompressedSize === 0xffffffff
    ) {
      throw new Error('Zip64 문서는 지원하지 않습니다.')
    }
    if (!bytesEqual(bytes, cursor + 46, localOffset + 30, nameLength)) {
      throw new Error('ZIP local/central 파일명이 일치하지 않습니다.')
    }
    validateZipExtra(view, localOffset + 30 + localNameLength, localExtraLength)

    const usesDataDescriptor = (flags & 0x0008) !== 0
    if (
      !usesDataDescriptor &&
      (localCrc32 !== crc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      throw new Error('ZIP local/central 크기 정보가 일치하지 않습니다.')
    }

    const dataStart = localOffset + localHeaderLength
    ensureZipRange(bytes.byteLength, dataStart, compressedSize)
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset) throw new Error('ZIP 항목 데이터 범위가 올바르지 않습니다.')
    localRanges.push({ start: localOffset, end: dataEnd })
    cursor += recordLength
  }

  if (cursor !== eocdOffset) throw new Error('ZIP central directory 크기가 일치하지 않습니다.')

  localRanges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new Error('ZIP 항목 데이터 범위가 서로 겹칩니다.')
    }
  }

  // EOCD 바로 앞의 Zip64 레코드는 sentinel을 숨긴 malformed archive일 수 있으므로 거부한다.
  if (eocdOffset >= 4 && view.getUint32(eocdOffset - 4, true) === ZIP64_EOCD_SIGNATURE) {
    throw new Error('Zip64 문서는 지원하지 않습니다.')
  }
}

/**
 * 경로를 canonical absolute path로 고정하고 descriptor에서 문서를 읽는다.
 * lstat → open(O_NOFOLLOW) → fstat identity를 교차 검증해 교체/심링크 race를 막고,
 * 정확히 한 ArrayBuffer에 읽는 동안 크기·mtime·identity 변화와 추가 byte를 거부한다.
 */
export async function readDoc(path: string, signal?: AbortSignal): Promise<OpenedDocument> {
  throwIfAborted(signal)
  const absolutePath = resolve(path)
  const ext = extname(absolutePath).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`지원하지 않는 형식입니다: ${ext || '(확장자 없음)'}`)
  }

  const requestedInfo = (await lstat(absolutePath, { bigint: true })) as StableStat
  if (requestedInfo.isSymbolicLink()) throw new Error('심볼릭 링크는 열 수 없습니다.')
  if (!requestedInfo.isFile()) throw new Error('정규 파일이 아닙니다.')

  const canonicalPath = await realpath(absolutePath)
  const canonicalInfo = (await lstat(canonicalPath, { bigint: true })) as StableStat
  if (canonicalInfo.isSymbolicLink()) throw new Error('심볼릭 링크는 열 수 없습니다.')
  if (!canonicalInfo.isFile() || !sameSnapshot(requestedInfo, canonicalInfo)) {
    throw new Error('파일 경로가 읽기 전에 변경되었습니다.')
  }

  const noFollow =
    process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number'
      ? 0
      : constants.O_NOFOLLOW
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow)
  try {
    throwIfAborted(signal)
    const openedInfo = (await handle.stat({ bigint: true })) as StableStat
    if (!openedInfo.isFile() || !sameSnapshot(canonicalInfo, openedInfo)) {
      throw new Error('파일이 읽기 전에 변경되었습니다.')
    }
    if (openedInfo.size === 0n) throw new Error('빈 파일입니다.')
    if (openedInfo.size > BigInt(MAX_BYTES)) {
      throw new Error(`파일이 너무 큽니다 (최대 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB).`)
    }

    const size = Number(openedInfo.size)
    const bytes = new ArrayBuffer(size)
    const target = new Uint8Array(bytes)
    let offset = 0

    while (offset < size) {
      throwIfAborted(signal)
      const length = Math.min(1024 * 1024, size - offset)
      const { bytesRead } = await handle.read(target, offset, length, offset)
      throwIfAborted(signal)
      if (bytesRead === 0) throw new Error('파일이 읽는 중 잘리거나 변경되었습니다.')
      offset += bytesRead
    }

    const extra = new Uint8Array(1)
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, size)
    throwIfAborted(signal)
    if (extraBytes !== 0) throw new Error('파일 크기가 읽는 중 변경되었습니다.')

    const finalInfo = (await handle.stat({ bigint: true })) as StableStat
    if (!sameSnapshot(openedInfo, finalInfo)) {
      throw new Error('파일이 읽는 중 변경되었습니다.')
    }

    if (ZIP_EXT.has(ext)) validateZipArchive(bytes)
    throwIfAborted(signal)
    return { name: basename(canonicalPath), ext, bytes, canonicalPath }
  } finally {
    await handle.close()
  }
}
