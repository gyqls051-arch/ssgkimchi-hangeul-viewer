import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** userData 아래 JSON 파일 경로 */
const filePath = (name: string): string => join(app.getPath('userData'), name)

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 원자적 쓰기: 임시파일에 쓰고 rename (중간 크래시 시 원본 보존) */
async function writeJsonAtomic(name: string, data: unknown): Promise<void> {
  const p = filePath(name)
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, p)
}

function writeJsonSync(name: string, data: unknown): void {
  const p = filePath(name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

/* ── 최근 파일 ───────────────────────────── */
export interface RecentEntry {
  path: string
  name: string
  ext: string
  openedAt: number
}

const RECENT_FILE = 'recent-files.json'
const RECENT_MAX = 12

// 모든 최근목록 변이를 단일 체인으로 직렬화 (read-modify-write 레이스로 항목이 유실되지 않게)
let recentChain: Promise<void> = Promise.resolve()
function serializeRecent(mutate: (list: RecentEntry[]) => RecentEntry[]): Promise<void> {
  recentChain = recentChain.then(async () => {
    const list = await readJson<RecentEntry[]>(RECENT_FILE, [])
    await writeJsonAtomic(RECENT_FILE, mutate(list))
  })
  return recentChain
}

export function getRecent(): Promise<RecentEntry[]> {
  // 진행 중 변이가 끝난 뒤의 최신 목록을 읽는다
  return recentChain.then(() => readJson<RecentEntry[]>(RECENT_FILE, []))
}

export function addRecent(entry: RecentEntry): Promise<void> {
  return serializeRecent((list) =>
    [entry, ...list.filter((e) => e.path !== entry.path)].slice(0, RECENT_MAX)
  )
}

export function removeRecent(path: string): Promise<void> {
  return serializeRecent((list) => list.filter((e) => e.path !== path))
}

export function clearRecent(): Promise<void> {
  return serializeRecent(() => [])
}

/** 경로가 최근 목록에 실제로 있는지 (renderer 가 임의 경로를 열지 못하게 검증용) */
export async function isKnownRecent(path: string): Promise<boolean> {
  const list = await getRecent()
  return list.some((e) => e.path === path)
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

export function getWindowState(): Promise<WindowState> {
  return readJson<WindowState>(WIN_FILE, { width: 1200, height: 820 })
}

/** 창 닫기 직전 동기 저장 (종료 레이스로 미저장되는 일이 없게) */
export function saveWindowStateSync(state: WindowState): void {
  try {
    writeJsonSync(WIN_FILE, state)
  } catch {
    /* 저장 실패는 치명적이지 않음 */
  }
}
