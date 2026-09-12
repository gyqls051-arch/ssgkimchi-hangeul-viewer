#!/usr/bin/env node
import {
  SBOM_PATH,
  generateSbom,
  parseCheckMode,
  writeOrCheckGeneratedFile
} from './compliance-lib.mjs'

try {
  const check = parseCheckMode(process.argv.slice(2))
  const result = writeOrCheckGeneratedFile(SBOM_PATH, generateSbom(), check)
  console.log(`[compliance] ${result.mode} ${result.path} (${result.bytes} bytes)`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
