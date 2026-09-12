import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { RecentItem } from '../preload/api'

/** userData 아래 JSON 파일 경로 */
const filePath = (name: string): string => join(app.getPath('userData'), name)

async function readJsonUnknown(name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath(name), 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** 임의 이름·0600 권한 임시파일에 쓴 뒤 rename한다. */
async function writeJsonAtomic(name: string, data: unknown): Promise<void> {
  const target = filePath(name)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function writeJsonSync(name: string, data: unknown): void {
  const target = filePath(name)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/* ── 최근 파일 ───────────────────────────── */
export interface RecentEntry {
  /** renderer에는 노출해도 경로를 유추할 수 없는 무작위 capability id */
  id: string
  /** main 프로세스에서만 보관하는 canonical absolute path */
  path: string
  name: string
  ext: string
  openedAt: number
}

export interface NewRecentEntry {
  path: string
  name: string
  ext: string
  openedAt: number
}

const RECENT_FILE = 'recent-files.json'
const RECENT_MAX = 12
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function normalizeRecentList(value: unknown): { entries: RecentEntry[]; changed: boolean } {
  if (!Array.isArray(value)) return { entries: [], changed: value !== undefined }

  const entries: RecentEntry[] = []
  const paths = new Set<string>()
  let changed = false

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      changed = true
      continue
    }
    const item = candidate as Record<string, unknown>
    if (
      !safeString(item.path, 32_768) ||
      !isAbsolute(item.path) ||
      !safeString(item.name, 1_024) ||
      !safeString(item.ext, 32) ||
      typeof item.openedAt !== 'number' ||
      !Number.isFinite(item.openedAt) ||
      item.openedAt < 0
    ) {
      changed = true
      continue
    }

    const canonicalPath = resolve(item.path)
    if (paths.has(canonicalPath)) {
      changed = true
      continue
    }
    paths.add(canonicalPath)

    const id = typeof item.id === 'string' && UUID_PATTERN.test(item.id) ? item.id : randomUUID()
    if (id !== item.id || canonicalPath !== item.path) changed = true
    entries.push({
      id,
      path: canonicalPath,
      name: item.name,
      ext: item.ext.toLowerCase(),
      openedAt: item.openedAt
    })
    if (entries.length === RECENT_MAX) {
      if (value.length > entries.length) changed = true
      break
    }
  }

  return { entries, changed }
}

async function loadRecent(): Promise<{ entries: RecentEntry[]; changed: boolean }> {
  return normalizeRecentList(await readJsonUnknown(RECENT_FILE))
}

// read/migrate/mutate를 하나의 회복 가능한 큐로 직렬화한다. 각 호출자는 자신의 실패를 받지만,
// tail은 실패를 삼켜 다음 최근 파일 작업이 영구적으로 막히지 않는다.
let recentTail: Promise<void> = Promise.resolve()
function enqueueRecent<T>(operation: () => Promise<T>): Promise<T> {
  const result = recentTail.then(operation)
  recentTail = result.then(
    () => undefined,
    (error: unknown) => {
      console.error('[store] recent-files 작업 실패:', error)
    }
  )
  return result
}

function mutateRecent(mutate: (list: RecentEntry[]) => RecentEntry[]): Promise<void> {
  return enqueueRecent(async () => {
    const { entries } = await loadRecent()
    await writeJsonAtomic(RECENT_FILE, mutate(entries).slice(0, RECENT_MAX))
  })
}

export function getRecent(): Promise<RecentEntry[]> {
  return enqueueRecent(async () => {
    const result = await loadRecent()
    if (result.changed) await writeJsonAtomic(RECENT_FILE, result.entries)
    return result.entries
  })
}

/** renderer에 허용된 최소 메타데이터만 반환한다. */
export async function listRecentItems(): Promise<RecentItem[]> {
  const list = await getRecent()
  return list.map(({ id, name, ext, openedAt }) => ({ id, name, ext, openedAt }))
}

export function addRecent(entry: NewRecentEntry): Promise<void> {
  const canonicalPath = resolve(entry.path)
  return mutateRecent((list) => {
    const previous = list.find((item) => item.path === canonicalPath)
    const next: RecentEntry = {
      id: previous?.id ?? randomUUID(),
      path: canonicalPath,
      name: entry.name,
      ext: entry.ext.toLowerCase(),
      openedAt: entry.openedAt
    }
    return [next, ...list.filter((item) => item.path !== canonicalPath)]
  })
}

export function removeRecentPath(path: string): Promise<void> {
  const canonicalPath = resolve(path)
  return mutateRecent((list) => list.filter((entry) => entry.path !== canonicalPath))
}

export function clearRecent(): Promise<void> {
  return mutateRecent(() => [])
}

/** opaque id를 main-only canonical path로 해석한다. */
export async function resolveRecentId(id: string): Promise<string | null> {
  if (!UUID_PATTERN.test(id)) return null
  const list = await getRecent()
  return list.find((entry) => entry.id === id)?.path ?? null
}

/* ── 창 상태 ─────────────────────────────── */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const WIN_FILE = 'window-state.json'

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

export async function getWindowState(): Promise<WindowState> {
  const value = await readJsonUnknown(WIN_FILE)
  if (!value || typeof value !== 'object') return { width: 1200, height: 820 }
  const raw = value as Record<string, unknown>
  const width = finiteCoordinate(raw.width)
  const height = finiteCoordinate(raw.height)
  if (width === undefined || height === undefined || width < 200 || height < 200) {
    return { width: 1200, height: 820 }
  }
  const x = finiteCoordinate(raw.x)
  const y = finiteCoordinate(raw.y)
  return {
    width,
    height,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(typeof raw.maximized === 'boolean' ? { maximized: raw.maximized } : {})
  }
}

/** 창 닫기 직전 동기 저장 (종료 레이스로 미저장되는 일이 없게) */
export function saveWindowStateSync(state: WindowState): void {
  try {
    writeJsonSync(WIN_FILE, state)
  } catch {
    /* 저장 실패는 치명적이지 않음 */
  }
}

/* ── 업데이트 설치 handoff 상태 ───────────── */
const UPDATE_INSTALL_FILE = 'update-install-pending.json'
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

interface UpdateInstallMarker {
  fromVersion: string
  targetVersion: string
  attemptedAt: number
}

function normalizeUpdateInstallMarker(value: unknown): UpdateInstallMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  if (
    typeof marker.fromVersion !== 'string' ||
    !STABLE_VERSION_PATTERN.test(marker.fromVersion) ||
    typeof marker.targetVersion !== 'string' ||
    !STABLE_VERSION_PATTERN.test(marker.targetVersion) ||
    typeof marker.attemptedAt !== 'number' ||
    !Number.isSafeInteger(marker.attemptedAt) ||
    marker.attemptedAt < 0
  ) {
    return null
  }
  return {
    fromVersion: marker.fromVersion,
    targetVersion: marker.targetVersion,
    attemptedAt: marker.attemptedAt
  }
}

export async function saveUpdateInstallMarker(
  fromVersion: string,
  targetVersion: string
): Promise<void> {
  if (!STABLE_VERSION_PATTERN.test(fromVersion) || !STABLE_VERSION_PATTERN.test(targetVersion)) {
    throw new Error('Update install marker requires stable versions')
  }
  await writeJsonAtomic(UPDATE_INSTALL_FILE, {
    fromVersion,
    targetVersion,
    attemptedAt: Date.now()
  } satisfies UpdateInstallMarker)
}

export async function clearUpdateInstallMarker(): Promise<void> {
  await unlink(filePath(UPDATE_INSTALL_FILE)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

/** 이전 handoff가 같은 버전으로 돌아왔으면 1회 실패로 보고하고 marker를 소비한다. */
export async function reconcileUpdateInstallMarker(currentVersion: string): Promise<boolean> {
  const marker = normalizeUpdateInstallMarker(await readJsonUnknown(UPDATE_INSTALL_FILE))
  if (!marker) {
    await clearUpdateInstallMarker()
    return false
  }
  await clearUpdateInstallMarker()
  return marker.fromVersion === currentVersion && marker.targetVersion !== currentVersion
}
