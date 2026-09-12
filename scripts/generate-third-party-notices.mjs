#!/usr/bin/env node
import {
  NOTICE_PATH,
  generateThirdPartyNotices,
  parseCheckMode,
  writeOrCheckGeneratedFile
} from './compliance-lib.mjs'

try {
  const check = parseCheckMode(process.argv.slice(2))
  const result = writeOrCheckGeneratedFile(NOTICE_PATH, generateThirdPartyNotices(), check)
  console.log(`[compliance] ${result.mode} ${result.path} (${result.bytes} bytes)`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
