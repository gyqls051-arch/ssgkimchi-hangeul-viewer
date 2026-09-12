#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import {
  MIT_LICENSE_TEXT,
  NOTICE_PATH,
  REPO_ROOT,
  SBOM_PATH,
  generateSbom,
  generateThirdPartyNotices,
  loadComplianceInventory
} from './compliance-lib.mjs'

const REQUIRED_DOCUMENTS = [
  'LICENSE',
  NOTICE_PATH,
  SBOM_PATH,
  'PRIVACY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'EULA.template.md',
  'LEGAL_REVIEW.md',
  'README.md'
]

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function readRepositoryText(path) {
  try {
    return readFileSync(resolve(REPO_ROOT, path), 'utf8').replace(/\r\n?/g, '\n')
  } catch (error) {
    failures.push(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function checkGenerated(path, expected) {
  const absolute = resolve(REPO_ROOT, path)
  let actual
  try {
    actual = readFileSync(absolute)
  } catch (error) {
    failures.push(`generated output is missing: ${path} (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  check(actual.equals(Buffer.from(expected, 'utf8')), `${path} is stale (generator byte comparison failed)`)
}

function checkReadme(readme, packageJson, lock) {
  const forbiddenClaims = [
    [/100\s*%\s*(?:오프라인|offline)/i, 'README must not claim 100% offline operation'],
    [/추가\s*정보\s*(?:→|->)\s*실행/i, 'README must not instruct users to bypass SmartScreen'],
    [/인쇄\s*\(\s*Ctrl\+P\s*\)/i, 'README must not advertise printing as a feature'],
    [/\|[^\n]*pptx-preview[^\n]*\|\s*MIT\s*\|/i, 'README must not label pptx-preview as MIT']
  ]
  for (const [pattern, message] of forbiddenClaims) check(!pattern.test(readme), message)

  const pptxLine = readme.split('\n').find((line) => line.includes('pptx-preview')) ?? ''
  check(/\bISC\b/.test(pptxLine), 'README pptx-preview row must report ISC package metadata')
  check(/법률.*(?:검토|승인)|(?:검토|승인).*법률/.test(pptxLine), 'README pptx-preview row must require legal review/approval')
  check(/로컬/.test(readme) && /업로드하지/.test(readme), 'README must use a scoped local-rendering/no-upload statement')
  check(/인쇄[^\n]*(?:미지원|지원하지|비활성화)/.test(readme), 'README must accurately state that printing is unavailable')

  for (const document of ['LICENSE', NOTICE_PATH, SBOM_PATH, 'PRIVACY.md', 'SUPPORT.md', 'LEGAL_REVIEW.md']) {
    check(readme.includes(`](${document})`), `README must link to ${document}`)
  }

  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
  for (const match of readme.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    check(Object.hasOwn(scripts, match[1]), `README references missing npm script: ${match[1]}`)
  }

  const markdownLinks = /!?\[[^\]]*\]\(([^)]+)\)/g
  for (const match of readme.matchAll(markdownLinks)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split(/\s+["']/)[0]
    if (/^(?:https?:|#)/i.test(target)) continue
    const withoutFragment = target.split('#')[0].split('?')[0]
    if (!withoutFragment) continue
    const decoded = decodeURIComponent(withoutFragment)
    const absolute = resolve(REPO_ROOT, decoded)
    check(
      absolute === REPO_ROOT || absolute.startsWith(`${REPO_ROOT}${sep}`),
      `README local link escapes the repository: ${target}`
    )
    check(existsSync(absolute), `README has a broken local link: ${target}`)
  }

  const pptxRecord = lock.packages?.['node_modules/pptx-preview']
  check(pptxRecord?.license === 'ISC', 'package-lock pptx-preview metadata must still be ISC')
}

function checkSbom(sbom, inventory) {
  check(sbom.bomFormat === 'CycloneDX', 'SBOM bomFormat must be CycloneDX')
  check(sbom.specVersion === '1.6', 'SBOM specVersion must be 1.6')
  check(sbom.$schema === 'https://cyclonedx.org/schema/bom-1.6.schema.json', 'SBOM must identify the CycloneDX 1.6 schema')
  check(/^urn:uuid:[0-9a-f-]{36}$/i.test(sbom.serialNumber ?? ''), 'SBOM serialNumber must be a deterministic UUID URN')

  const components = Array.isArray(sbom.components) ? sbom.components : []
  const dependencies = Array.isArray(sbom.dependencies) ? sbom.dependencies : []
  const refs = new Set([sbom.metadata?.component?.['bom-ref'], ...components.map((component) => component['bom-ref'])])
  check(components.length === inventory.packages.length + inventory.assets.length, 'SBOM component count does not match the generated inventory')

  const npmComponents = components.filter((component) =>
    component.properties?.some((property) => property.name === 'ssgkimchi:inventory:package-path')
  )
  for (const component of npmComponents) {
    check(/^pkg:npm\//.test(component.purl ?? ''), `SBOM npm component lacks a purl: ${component.name}`)
    check(Array.isArray(component.hashes) && component.hashes.length > 0, `SBOM npm component lacks a lock integrity hash: ${component.name}`)
  }

  const electron = npmComponents.find((component) => component.name === 'electron')
  check(Boolean(electron), 'SBOM must include Electron despite its development-dependency lock flag')
  const chromium = components.find((component) => component['bom-ref'] === 'asset:electron:chromium-runtime')
  const rhwpWasm = components.find((component) => component['bom-ref'] === 'asset:rhwp:rhwp-bg-wasm')
  check(Boolean(chromium), 'SBOM must include the Chromium runtime notice component')
  check(Boolean(rhwpWasm), 'SBOM must include the @rhwp/core WASM component')

  const dependencyRefs = new Set()
  for (const dependency of dependencies) {
    check(refs.has(dependency.ref), `SBOM dependency graph contains an unknown ref: ${dependency.ref}`)
    check(!dependencyRefs.has(dependency.ref), `SBOM dependency graph contains duplicate ref: ${dependency.ref}`)
    dependencyRefs.add(dependency.ref)
    for (const target of dependency.dependsOn ?? []) {
      check(refs.has(target), `SBOM dependency graph targets an unknown ref: ${target}`)
    }
  }
  for (const ref of refs) check(dependencyRefs.has(ref), `SBOM dependency graph omits component ref: ${ref}`)

  const rootDependency = dependencies.find((dependency) => dependency.ref === inventory.root.bomRef)
  check(rootDependency?.dependsOn?.includes(electron?.['bom-ref']), 'SBOM root dependency graph must reference Electron')

  const metadataProperties = sbom.metadata?.properties ?? []
  check(
    metadataProperties.some((property) => property.name === 'ssgkimchi:inventory:scope-limitation:chromium'),
    'SBOM must disclose Chromium scope limits'
  )
  check(
    metadataProperties.some((property) => property.name === 'ssgkimchi:inventory:scope-limitation:rhwp-wasm'),
    'SBOM must disclose @rhwp WASM scope limits'
  )
}

try {
  if (process.argv.length > 2) throw new Error('verify-compliance.mjs accepts no arguments')

  for (const document of REQUIRED_DOCUMENTS) {
    const absolute = resolve(REPO_ROOT, document)
    check(existsSync(absolute), `required compliance document is missing: ${document}`)
    if (existsSync(absolute)) check(readFileSync(absolute).length > 0, `required compliance document is empty: ${document}`)
  }

  const inventory = loadComplianceInventory()
  checkGenerated(NOTICE_PATH, generateThirdPartyNotices(inventory))
  checkGenerated(SBOM_PATH, generateSbom(inventory))

  const license = readRepositoryText('LICENSE')
  check(license === MIT_LICENSE_TEXT, 'LICENSE must be the approved repository-intent MIT text for Copyright (c) 2026 싹싹김치')

  const packageJson = JSON.parse(readRepositoryText('package.json'))
  const lock = JSON.parse(readRepositoryText('package-lock.json'))
  const readme = readRepositoryText('README.md')
  checkReadme(readme, packageJson, lock)

  const privacy = readRepositoryText('PRIVACY.md')
  check(privacy.includes('recent-files.json'), 'PRIVACY.md must disclose recent-files.json')
  check(privacy.includes('window-state.json'), 'PRIVACY.md must disclose window-state.json')
  check(privacy.includes('update-install-pending.json'), 'PRIVACY.md must disclose update-install-pending.json')
  check(privacy.includes('https://github.com/gyqls051-arch/ssgkimchi-hangeul-viewer/issues'), 'PRIVACY.md must use GitHub Issues as the proposed contact')
  check(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(privacy), 'PRIVACY.md must not invent an email contact')

  const support = readRepositoryText('SUPPORT.md')
  check(support.includes('https://github.com/gyqls051-arch/ssgkimchi-hangeul-viewer/issues'), 'SUPPORT.md must use GitHub Issues as the proposed contact')
  check(/SLA[^\n]*(?:없|제공하지)/i.test(support), 'SUPPORT.md must explicitly disclaim an SLA')
  check(!/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(support), 'SUPPORT.md must not invent an email contact')

  const eula = readRepositoryText('EULA.template.md')
  check(/비운영|NON-OPERATIVE/i.test(eula), 'EULA template must be clearly non-operative')
  check(/법률.*승인|승인.*법률/.test(eula), 'EULA template must require legal approval before use')

  const legalReview = readRepositoryText('LEGAL_REVIEW.md')
  check(/외부/.test(legalReview) && /권리자/.test(legalReview) && /법률.*승인/.test(legalReview), 'LEGAL_REVIEW.md must state that rights-holder/legal approval remains external')
  check(/pptx-preview/.test(legalReview) && /ISC/.test(legalReview), 'LEGAL_REVIEW.md must track pptx-preview ISC provenance review')
  check(/rhwp_bg\.wasm|WASM/.test(legalReview), 'LEGAL_REVIEW.md must track @rhwp WASM scope limits')

  const notices = readRepositoryText(NOTICE_PATH)
  const pptxNoticeComponent = inventory.byPath.get('node_modules/pptx-preview')
  check(Boolean(pptxNoticeComponent), 'compliance inventory must include pptx-preview')
  const noticeMarkers = [
    'PDF.JS FOXIT STANDARD FONT LICENSE',
    'PDF.JS LIBERATION SANS FONT LICENSE',
    'LICENSES.chromium.html',
    '@RHWP/CORE WEBASSEMBLY SCOPE DISCLOSURE'
  ]
  if (pptxNoticeComponent) {
    noticeMarkers.push(
      `${pptxNoticeComponent.name}@${pptxNoticeComponent.version} declares ${pptxNoticeComponent.license} in package metadata.`
    )
  }
  for (const marker of noticeMarkers) {
    check(notices.includes(marker), `${NOTICE_PATH} is missing required disclosure: ${marker}`)
  }

  let sbom = null
  try {
    sbom = JSON.parse(readRepositoryText(SBOM_PATH))
  } catch (error) {
    failures.push(`${SBOM_PATH} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (sbom) checkSbom(sbom, inventory)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.error(`[compliance] verification failed with ${failures.length} issue(s)`)
  process.exitCode = 1
} else {
  console.log(`[compliance] verified ${REQUIRED_DOCUMENTS.length} required documents`)
  console.log('[compliance] generated outputs match byte-for-byte')
  console.log('[compliance] README claims and local links are consistent')
}
