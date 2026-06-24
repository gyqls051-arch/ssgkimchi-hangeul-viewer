import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
export const mainEntry = join(root, 'out', 'main', 'index.js')
export const fixture = (name: string): string => join(root, 'tests', 'fixtures', name)

/**
 * 빌드된 앱을 electron 으로 띄운다.
 * - ELECTRON_RUN_AS_NODE 제거(순수 Node 가 아닌 electron 으로 실행)
 * - SSGKIMCHI_OPEN_ON_START 로 지정 파일 자동 열기(dev/preview 한정)
 * - 실행마다 별도 --user-data-dir → 단일 인스턴스 락 경합/플래키 방지
 */
export async function launchWith(file: string): Promise<ElectronApplication> {
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  env.SSGKIMCHI_OPEN_ON_START = file
  const userData = mkdtempSync(join(tmpdir(), 'ssgkimchi-e2e-'))
  return electron.launch({ args: [mainEntry, `--user-data-dir=${userData}`], env })
}
