#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const NOTICE_PATH = 'THIRD_PARTY_NOTICES.txt'
export const SBOM_PATH = 'sbom.cdx.json'

const LOCK_PATH = 'package-lock.json'
const ELECTRON_PACKAGE_PATH = 'node_modules/electron'
const PDFJS_PACKAGE_PATH = 'node_modules/pdfjs-dist'
const PPTX_PACKAGE_PATH = 'node_modules/pptx-preview'
const RHWP_PACKAGE_PATH = 'node_modules/@rhwp/core'
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i

const ASSET_REFS = Object.freeze({
  chromium: 'asset:electron:chromium-runtime',
  foxitFonts: 'asset:pdfjs:foxit-standard-fonts',
  liberationFonts: 'asset:pdfjs:liberation-sans-fonts',
  cmaps: 'asset:pdfjs:adobe-cmaps',
  rhwpWasm: 'asset:rhwp:rhwp-bg-wasm'
})

export const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 싹싹김치

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

function fail(message) {
  throw new Error(`[compliance] ${message}`)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function absolutePath(repositoryPath) {
  const absolute = resolve(REPO_ROOT, repositoryPath)
  if (absolute !== REPO_ROOT && !absolute.startsWith(`${REPO_ROOT}${sep}`)) {
    fail(`path escapes repository: ${repositoryPath}`)
  }
  return absolute
}

function readRequiredBuffer(repositoryPath) {
  try {
    return readFileSync(absolutePath(repositoryPath))
  } catch (error) {
    fail(`cannot read ${repositoryPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readRequiredText(repositoryPath) {
  return normalizeText(readRequiredBuffer(repositoryPath).toString('utf8'))
}

function readJson(repositoryPath) {
  try {
    return JSON.parse(readRequiredText(repositoryPath))
  } catch (error) {
    fail(`invalid JSON in ${repositoryPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function textBlock(value) {
  return normalizeText(value).replace(/\n+$/g, '')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashFiles(repositoryPaths) {
  const hash = createHash('sha256')
  for (const repositoryPath of [...repositoryPaths].sort()) {
    const bytes = readRequiredBuffer(repositoryPath)
    hash.update(repositoryPath, 'utf8')
    hash.update('\0')
    hash.update(String(bytes.length), 'utf8')
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function listFiles(repositoryDirectory, predicate) {
  const directory = absolutePath(repositoryDirectory)
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    fail(`cannot list ${repositoryDirectory}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return entries
    .filter((entry) => {
      if (!predicate(entry.name)) return false
      if (entry.isFile()) return true
      if (!entry.isSymbolicLink()) return false
      try {
        return statSync(join(directory, entry.name)).isFile()
      } catch {
        return false
      }
    })
    .map((entry) => posix.join(repositoryDirectory, entry.name))
    .sort()
}

function packageNameFromPath(packagePath) {
  const marker = 'node_modules/'
  const index = packagePath.lastIndexOf(marker)
  if (index < 0) fail(`unsupported lockfile package path: ${packagePath}`)
  const suffix = packagePath.slice(index + marker.length)
  const parts = suffix.split('/')
  const name = suffix.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!name || name.includes('..')) fail(`invalid package name derived from ${packagePath}`)
  return name
}

function npmPurl(name, version) {
  const encodedName = name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function packageBomRef(name, version, packagePath) {
  return `npm:${name}@${version}:${packagePath}`
}

function dependencyDeclarations(record) {
  const declarations = new Map()
  const priorities = { required: 0, optional: 1, peer: 2, 'optional-peer': 3 }

  const add = (field, kind) => {
    const value = record[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const name of Object.keys(value).sort()) {
      const previous = declarations.get(name)
      if (!previous || priorities[kind] < priorities[previous.kind]) {
        declarations.set(name, { name, kind })
      }
    }
  }

  add('dependencies', 'required')
  add('optionalDependencies', 'optional')

  const peers = record.peerDependencies
  if (peers && typeof peers === 'object' && !Array.isArray(peers)) {
    for (const name of Object.keys(peers).sort()) {
      if (declarations.has(name)) continue
      const optional = record.peerDependenciesMeta?.[name]?.optional === true
      declarations.set(name, { name, kind: optional ? 'optional-peer' : 'peer' })
    }
  }

  return [...declarations.values()].sort((left, right) => compareText(left.name, right.name))
}

function resolveLockedDependency(packages, parentPath, dependencyName) {
  if (
    typeof dependencyName !== 'string' ||
    dependencyName.length === 0 ||
    dependencyName.includes('\\') ||
    dependencyName.split('/').includes('..')
  ) {
    fail(`invalid dependency name ${JSON.stringify(dependencyName)} under ${parentPath || '<root>'}`)
  }

  let cursor = parentPath
  while (true) {
    const candidate = posix.join(cursor, 'node_modules', dependencyName)
    if (Object.hasOwn(packages, candidate)) return candidate
    if (cursor === '') break
    const parent = posix.dirname(cursor)
    cursor = parent === '.' || parent === cursor ? '' : parent
  }
  return null
}

function collectProductionClosure(packages, rootRecord) {
  const rootDependencies = rootRecord.dependencies
  if (!rootDependencies || typeof rootDependencies !== 'object' || Array.isArray(rootDependencies)) {
    fail('package-lock root record has no dependencies object')
  }

  const directPaths = []
  for (const name of Object.keys(rootDependencies).sort()) {
    const packagePath = resolveLockedDependency(packages, '', name)
    if (!packagePath) fail(`root production dependency is missing from lockfile: ${name}`)
    directPaths.push(packagePath)
  }

  const closure = new Set()
  const unresolved = []
  const queue = [...directPaths]

  while (queue.length > 0) {
    queue.sort()
    const packagePath = queue.shift()
    if (closure.has(packagePath)) continue
    closure.add(packagePath)

    const record = packages[packagePath]
    if (!record || typeof record !== 'object') fail(`missing lockfile record for ${packagePath}`)

    for (const declaration of dependencyDeclarations(record)) {
      const resolvedPath = resolveLockedDependency(packages, packagePath, declaration.name)
      if (resolvedPath) {
        if (!closure.has(resolvedPath)) queue.push(resolvedPath)
        continue
      }

      if (declaration.kind === 'required') {
        fail(`required dependency ${declaration.name} of ${packagePath} is missing from lockfile`)
      }
      unresolved.push({
        parentPath: packagePath,
        name: declaration.name,
        kind: declaration.kind
      })
    }
  }

  unresolved.sort((left, right) =>
    compareText(
      `${left.parentPath}\0${left.name}\0${left.kind}`,
      `${right.parentPath}\0${right.name}\0${right.kind}`
    )
  )
  return { closure, directPaths, unresolved }
}

function isPlatformConstrainedOptional(record) {
  return (
    record.optional === true &&
    ['os', 'cpu', 'libc'].some(
      (field) => Array.isArray(record[field]) && record[field].length > 0
    )
  )
}

function packageLicenseFiles(packagePath, record) {
  // Platform-constrained optional packages are represented on every host by lock metadata,
  // but npm extracts only matching variants. Omitting just those host-specific texts keeps
  // checked output stable while preserving available licenses for platform-neutral optionals.
  if (isPlatformConstrainedOptional(record)) return []

  const directory = absolutePath(packagePath)
  if (!existsSync(directory)) fail(`installed production package is missing: ${packagePath}`)

  return listFiles(packagePath, (name) => LICENSE_FILE_PATTERN.test(name)).map((repositoryPath) => {
    const content = readRequiredText(repositoryPath)
    return {
      path: repositoryPath,
      sha256: sha256(Buffer.from(content, 'utf8')),
      content
    }
  })
}

function readInstalledManifest(packagePath, record) {
  if (isPlatformConstrainedOptional(record)) return null
  const manifestPath = posix.join(packagePath, 'package.json')
  if (!existsSync(absolutePath(manifestPath))) fail(`installed package manifest is missing: ${manifestPath}`)
  const manifest = readJson(manifestPath)
  if (manifest.version !== record.version) {
    fail(
      `installed version mismatch for ${packagePath}: lock=${record.version}, installed=${String(manifest.version)}`
    )
  }
  return manifest
}

function parseIntegrity(integrity) {
  if (typeof integrity !== 'string') return null
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha(?:256|384|512))-(.+)$/i.exec(token)
    if (!match) continue
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0) continue
    return {
      algorithm: match[1].toUpperCase().replace('SHA', 'SHA-'),
      content: bytes.toString('hex').toUpperCase()
    }
  }
  return null
}

function licenseChoice(license) {
  if (typeof license !== 'string' || license.length === 0 || license === 'NOASSERTION') {
    return [{ license: { name: 'NOASSERTION' } }]
  }
  if (/^[A-Za-z0-9.+-]+$/.test(license)) return [{ license: { id: license } }]
  return [{ expression: license }]
}

function extractRhwpCrateTable(readme) {
  const normalized = normalizeText(readme)
  const sectionStart = normalized.indexOf('## Third-Party Licenses')
  if (sectionStart < 0) fail('@rhwp/core README has no Third-Party Licenses section')
  const sectionEnd = normalized.indexOf('\n## ', sectionStart + 3)
  const section = normalized.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd)
  const lines = section.split('\n')
  const tableStart = lines.findIndex((line) => line.startsWith('| 크레이트'))
  if (tableStart < 0) fail('@rhwp/core README third-party crate table is missing')
  const table = []
  for (const line of lines.slice(tableStart)) {
    if (!line.startsWith('|')) break
    table.push(line)
  }
  if (table.length < 3) fail('@rhwp/core README third-party crate table is incomplete')
  return table.join('\n')
}

function deterministicUuid(hexDigest) {
  const bytes = Buffer.from(hexDigest.slice(0, 32), 'hex')
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function loadAssets(pdfjsVersion, rhwpVersion, electronVersion) {
  const foxitLicensePath = `${PDFJS_PACKAGE_PATH}/standard_fonts/LICENSE_FOXIT`
  const liberationLicensePath = `${PDFJS_PACKAGE_PATH}/standard_fonts/LICENSE_LIBERATION`
  const cmapLicensePath = `${PDFJS_PACKAGE_PATH}/cmaps/LICENSE`
  const rhwpWasmPath = `${RHWP_PACKAGE_PATH}/rhwp_bg.wasm`
  const rhwpReadmePath = `${RHWP_PACKAGE_PATH}/README.md`
  const chromiumNoticePath = `${ELECTRON_PACKAGE_PATH}/dist/LICENSES.chromium.html`

  const foxitFiles = listFiles(`${PDFJS_PACKAGE_PATH}/standard_fonts`, (name) => /^Foxit.*\.pfb$/.test(name))
  const liberationFiles = listFiles(
    `${PDFJS_PACKAGE_PATH}/standard_fonts`,
    (name) => /^LiberationSans.*\.ttf$/.test(name)
  )
  const cmapFiles = listFiles(`${PDFJS_PACKAGE_PATH}/cmaps`, (name) => name.endsWith('.bcmap'))
  if (foxitFiles.length === 0 || liberationFiles.length === 0 || cmapFiles.length === 0) {
    fail('PDF.js font or CMap assets are missing from node_modules')
  }

  const foxitLicense = readRequiredText(foxitLicensePath)
  const liberationLicense = readRequiredText(liberationLicensePath)
  const cmapLicense = readRequiredText(cmapLicensePath)
  const rhwpWasm = readRequiredBuffer(rhwpWasmPath)
  const rhwpReadme = readRequiredText(rhwpReadmePath)
  // 존재 검증만 한다. LICENSES.chromium.html 은 Electron dist 플랫폼 빌드마다
  // 바이트가 달라(Windows/Linux 해시 불일치 확인) 생성 출력에 해시를 박으면
  // 어느 호스트에서 --check 를 돌려도 stale 판정이 난다.
  readRequiredBuffer(chromiumNoticePath)

  return [
    {
      key: 'chromium',
      bomRef: ASSET_REFS.chromium,
      type: 'framework',
      name: 'Chromium runtime embedded in Electron',
      version: `bundled with Electron ${electronVersion}`,
      ownerPath: ELECTRON_PACKAGE_PATH,
      licenseName: 'Multiple licenses; see LICENSES.chromium.html',
      noticePath: chromiumNoticePath,
      scopeNote:
        'Chromium and its internal third-party components are not expanded into npm components; the Electron runtime notice is authoritative.'
    },
    {
      key: 'foxitFonts',
      bomRef: ASSET_REFS.foxitFonts,
      type: 'file',
      name: 'PDF.js Foxit standard fonts',
      version: pdfjsVersion,
      ownerPath: PDFJS_PACKAGE_PATH,
      hash: hashFiles(foxitFiles),
      hashScope: `${foxitFiles.length} Foxit .pfb files`,
      licenseName: 'PDFium Foxit font redistribution terms',
      licensePath: foxitLicensePath,
      licenseSha256: sha256(Buffer.from(foxitLicense, 'utf8')),
      licenseText: foxitLicense
    },
    {
      key: 'liberationFonts',
      bomRef: ASSET_REFS.liberationFonts,
      type: 'file',
      name: 'PDF.js Liberation Sans standard fonts',
      version: pdfjsVersion,
      ownerPath: PDFJS_PACKAGE_PATH,
      hash: hashFiles(liberationFiles),
      hashScope: `${liberationFiles.length} Liberation Sans .ttf files`,
      licenseName: 'Liberation Font Software license agreement',
      licensePath: liberationLicensePath,
      licenseSha256: sha256(Buffer.from(liberationLicense, 'utf8')),
      licenseText: liberationLicense
    },
    {
      key: 'cmaps',
      bomRef: ASSET_REFS.cmaps,
      type: 'file',
      name: 'PDF.js Adobe CMaps',
      version: pdfjsVersion,
      ownerPath: PDFJS_PACKAGE_PATH,
      hash: hashFiles(cmapFiles),
      hashScope: `${cmapFiles.length} .bcmap files`,
      licenseName: 'Adobe CMap redistribution terms',
      licensePath: cmapLicensePath,
      licenseSha256: sha256(Buffer.from(cmapLicense, 'utf8')),
      licenseText: cmapLicense
    },
    {
      key: 'rhwpWasm',
      bomRef: ASSET_REFS.rhwpWasm,
      type: 'file',
      name: '@rhwp/core WebAssembly module',
      version: rhwpVersion,
      ownerPath: RHWP_PACKAGE_PATH,
      hash: sha256(rhwpWasm),
      hashScope: 'rhwp_bg.wasm',
      licenseName: 'See @rhwp/core and embedded Rust crate scope limitation',
      sourcePath: rhwpWasmPath,
      readmePath: rhwpReadmePath,
      readmeSha256: sha256(Buffer.from(rhwpReadme, 'utf8')),
      crateTable: extractRhwpCrateTable(rhwpReadme),
      scopeNote:
        'The npm lockfile identifies @rhwp/core but does not enumerate Rust crates compiled into the WASM. The local package has no crate-level THIRD_PARTY_LICENSES file.'
    }
  ]
}

function assertMatchingStringMap(label, manifestValue, lockValue) {
  if (
    !manifestValue ||
    typeof manifestValue !== 'object' ||
    Array.isArray(manifestValue) ||
    !lockValue ||
    typeof lockValue !== 'object' ||
    Array.isArray(lockValue)
  ) {
    fail(`${label} must exist in both package.json and package-lock.json`)
  }

  const names = [...new Set([...Object.keys(manifestValue), ...Object.keys(lockValue)])].sort()
  for (const name of names) {
    if (manifestValue[name] !== lockValue[name]) {
      fail(
        `${label} drift for ${name}: package.json=${JSON.stringify(manifestValue[name])}, package-lock.json=${JSON.stringify(lockValue[name])}`
      )
    }
  }
}

export function loadComplianceInventory() {
  const lockBuffer = readRequiredBuffer(LOCK_PATH)
  let lock
  try {
    lock = JSON.parse(lockBuffer.toString('utf8'))
  } catch (error) {
    fail(`invalid JSON in ${LOCK_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    fail('package-lock.json must be a lockfileVersion 3 file with a packages object')
  }
  const packages = lock.packages
  const rootRecord = packages['']
  if (!rootRecord || typeof rootRecord !== 'object') fail('package-lock root package record is missing')
  if (typeof rootRecord.name !== 'string' || typeof rootRecord.version !== 'string') {
    fail('package-lock root package name/version is missing')
  }

  const packageManifest = readJson('package.json')
  if (packageManifest.name !== rootRecord.name || packageManifest.version !== rootRecord.version) {
    fail(
      `package identity drift: package.json=${String(packageManifest.name)}@${String(packageManifest.version)}, package-lock.json=${rootRecord.name}@${rootRecord.version}`
    )
  }
  assertMatchingStringMap('production dependencies', packageManifest.dependencies, rootRecord.dependencies)

  const manifestElectron = packageManifest.devDependencies?.electron
  const lockElectron = rootRecord.devDependencies?.electron
  if (typeof manifestElectron !== 'string' || manifestElectron !== lockElectron) {
    fail(
      `Electron declaration drift: package.json=${JSON.stringify(manifestElectron)}, package-lock.json=${JSON.stringify(lockElectron)}`
    )
  }

  const production = collectProductionClosure(packages, rootRecord)
  const electronRecord = packages[ELECTRON_PACKAGE_PATH]
  if (!electronRecord || typeof electronRecord !== 'object') {
    fail('Electron must be present in package-lock.json as the shipped runtime')
  }
  if (typeof electronRecord.version !== 'string') fail('Electron lock record has no version')
  if (manifestElectron !== electronRecord.version) {
    fail(
      `Electron must be pinned to the shipped lock version: declared=${manifestElectron}, locked=${electronRecord.version}`
    )
  }

  const electronVersionPath = `${ELECTRON_PACKAGE_PATH}/dist/version`
  const installedElectronVersion = textBlock(readRequiredText(electronVersionPath)).trim()
  if (installedElectronVersion !== electronRecord.version) {
    fail(
      `Electron runtime version mismatch: lock=${electronRecord.version}, dist=${installedElectronVersion}`
    )
  }

  const allPaths = [...production.closure]
  if (!production.closure.has(ELECTRON_PACKAGE_PATH)) allPaths.push(ELECTRON_PACKAGE_PATH)
  allPaths.sort()
  const allPathSet = new Set(allPaths)

  const packageEntries = allPaths.map((packagePath) => {
    const record = packages[packagePath]
    if (!record || typeof record !== 'object' || typeof record.version !== 'string') {
      fail(`invalid package record for ${packagePath}`)
    }
    const manifest = readInstalledManifest(packagePath, record)
    const derivedName = packageNameFromPath(packagePath)
    const name = typeof manifest?.name === 'string' ? manifest.name : derivedName
    const license =
      typeof record.license === 'string'
        ? record.license
        : typeof manifest?.license === 'string'
          ? manifest.license
          : 'NOASSERTION'
    const purl = npmPurl(name, record.version)

    return {
      packagePath,
      name,
      version: record.version,
      purl,
      bomRef: packageBomRef(name, record.version, packagePath),
      license,
      integrity: typeof record.integrity === 'string' ? record.integrity : null,
      integrityHash: parseIntegrity(record.integrity),
      resolved: typeof record.resolved === 'string' ? record.resolved : null,
      optional: record.optional === true,
      platformConstrainedOptional: isPlatformConstrainedOptional(record),
      devFlag: record.dev === true,
      scope: production.closure.has(packagePath) ? 'declared-production-closure' : 'shipped-electron-runtime',
      licenseFiles: packageLicenseFiles(packagePath, record),
      dependencies:
        packagePath === ELECTRON_PACKAGE_PATH
          ? []
          : dependencyDeclarations(record)
              .map((declaration) => ({
                ...declaration,
                packagePath: resolveLockedDependency(packages, packagePath, declaration.name)
              }))
              .filter((dependency) => dependency.packagePath && allPathSet.has(dependency.packagePath))
    }
  })

  const byPath = new Map(packageEntries.map((entry) => [entry.packagePath, entry]))
  for (const entry of packageEntries) {
    entry.dependencies = entry.dependencies
      .map((dependency) => ({
        name: dependency.name,
        kind: dependency.kind,
        packagePath: dependency.packagePath,
        bomRef: byPath.get(dependency.packagePath)?.bomRef
      }))
      .filter((dependency) => typeof dependency.bomRef === 'string')
      .sort((left, right) => compareText(left.bomRef, right.bomRef))
  }

  const pdfjs = byPath.get(PDFJS_PACKAGE_PATH)
  const rhwp = byPath.get(RHWP_PACKAGE_PATH)
  const electron = byPath.get(ELECTRON_PACKAGE_PATH)
  if (!pdfjs || !rhwp || !electron) {
    fail('required PDF.js, @rhwp/core, or Electron component is outside the compliance inventory')
  }
  const assets = loadAssets(pdfjs.version, rhwp.version, electron.version)

  const fingerprint = sha256(
    Buffer.from(
      JSON.stringify({
        lockSha256: sha256(lockBuffer),
        packages: packageEntries.map((entry) => ({
          path: entry.packagePath,
          integrity: entry.integrity,
          license: entry.license,
          licenseFiles: entry.licenseFiles.map((file) => ({ path: file.path, sha256: file.sha256 }))
        })),
        assets: assets.map((asset) => ({
          ref: asset.bomRef,
          hash: asset.hash ?? null,
          noticeSha256: asset.noticeSha256 ?? null,
          licenseSha256: asset.licenseSha256 ?? null,
          readmeSha256: asset.readmeSha256 ?? null
        }))
      }),
      'utf8'
    )
  )

  return {
    lock,
    lockSha256: sha256(lockBuffer),
    root: {
      name: rootRecord.name,
      version: rootRecord.version,
      purl: npmPurl(rootRecord.name, rootRecord.version),
      bomRef: `app:${rootRecord.name}@${rootRecord.version}`
    },
    packages: packageEntries,
    byPath,
    assets,
    productionDirectPaths: production.directPaths,
    unresolved: production.unresolved,
    fingerprint,
    serialNumber: `urn:uuid:${deterministicUuid(fingerprint)}`
  }
}

function renderAssetLicense(lines, title, asset) {
  lines.push('='.repeat(78))
  lines.push(title)
  lines.push('='.repeat(78))
  lines.push(`Component: ${asset.name} (${asset.version})`)
  lines.push(`Asset digest (SHA-256): ${asset.hash}`)
  lines.push(`Digest scope: ${asset.hashScope}`)
  lines.push(`License source: ${asset.licensePath}`)
  lines.push(`License text SHA-256: ${asset.licenseSha256}`)
  lines.push('')
  lines.push(`----- BEGIN ${asset.licensePath} -----`)
  lines.push(textBlock(asset.licenseText))
  lines.push(`----- END ${asset.licensePath} -----`)
  lines.push('')
}

export function generateThirdPartyNotices(inventory = loadComplianceInventory()) {
  const pptx = inventory.byPath.get(PPTX_PACKAGE_PATH)
  if (!pptx) fail('pptx-preview is outside the compliance inventory')
  const pptxLicenseStatus =
    pptx.licenseFiles.length === 0
      ? 'The installed package has no LICENSE/COPYING/NOTICE file at its package root.'
      : `Installed package license files: ${pptx.licenseFiles.map((file) => file.path).join(', ')}.`

  const lines = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'GENERATED FILE — DO NOT EDIT BY HAND.',
    'Regenerate with: node scripts/generate-third-party-notices.mjs',
    'Verify with:     node scripts/generate-third-party-notices.mjs --check',
    '',
    `Application: ${inventory.root.name}@${inventory.root.version}`,
    `Lockfile SHA-256: ${inventory.lockSha256}`,
    `Inventory fingerprint: ${inventory.fingerprint}`,
    '',
    'SCOPE AND LIMITATIONS',
    '',
    'This deterministic, offline inventory starts at package-lock.json root production',
    'dependencies and follows required dependencies, optional dependencies, and installed',
    'peer resolutions conservatively across the lockfile. Platform-specific optional lock',
    'entries remain listed even when they are not installed or shipped on a target platform.',
    '',
    'Electron is included explicitly because Electron Builder ships its runtime even though',
    'the npm package is classified as a development dependency. Electron npm install-helper',
    'dependencies are not labeled as shipped runtime content. Chromium internals are not npm',
    'packages and are not expanded here; the Electron LICENSES.chromium.html file referenced',
    'below is the authoritative Chromium third-party notice set.',
    '',
    'The application bundles @rhwp/core/rhwp_bg.wasm. package-lock.json describes the npm',
    'wrapper but cannot enumerate Rust crates compiled into that binary. The installed npm',
    'package does not contain the linked crate-level THIRD_PARTY_LICENSES file. The informative',
    'crate families from its local README are reproduced below, but exact crate versions and',
    'complete crate license texts require a version-bound upstream inventory and legal review.',
    '',
    `${pptx.name}@${pptx.version} declares ${pptx.license} in package metadata.`,
    pptxLicenseStatus,
    'The generated package section reproduces locally available license text and does not',
    'invent absent grant or copyright text. Redistribution terms and provenance require',
    'legal approval.',
    '',
    'Platform-constrained optional package records use lockfile license metadata and integrity',
    'only; their host-dependent extracted license files are intentionally not embedded so',
    '--check is stable across supported build hosts. Platform-neutral optional package license',
    'files are included when available. This inventory is an engineering aid, not legal advice',
    'or evidence that a release has received rights-holder or legal approval.',
    ''
  ]

  const chromium = inventory.assets.find((asset) => asset.key === 'chromium')
  const rhwpWasm = inventory.assets.find((asset) => asset.key === 'rhwpWasm')
  const foxit = inventory.assets.find((asset) => asset.key === 'foxitFonts')
  const liberation = inventory.assets.find((asset) => asset.key === 'liberationFonts')
  const cmaps = inventory.assets.find((asset) => asset.key === 'cmaps')
  if (!chromium || !rhwpWasm || !foxit || !liberation || !cmaps) {
    fail('special compliance assets are incomplete')
  }

  lines.push('='.repeat(78))
  lines.push('ELECTRON / CHROMIUM NOTICE REFERENCE')
  lines.push('='.repeat(78))
  lines.push(`Component: ${chromium.name} (${chromium.version})`)
  lines.push(`Source notice: ${chromium.noticePath}`)
  lines.push('Runtime reference: LICENSES.chromium.html beside the packaged Electron executable.')
  lines.push('The large HTML notice is referenced rather than duplicated in this text file.')
  lines.push(`Scope limitation: ${chromium.scopeNote}`)
  lines.push('')

  lines.push('='.repeat(78))
  lines.push('@RHWP/CORE WEBASSEMBLY SCOPE DISCLOSURE')
  lines.push('='.repeat(78))
  lines.push(`Component: ${rhwpWasm.name} (${rhwpWasm.version})`)
  lines.push(`Source module: ${rhwpWasm.sourcePath}`)
  lines.push(`Module SHA-256: ${rhwpWasm.hash}`)
  lines.push(`README source: ${rhwpWasm.readmePath}`)
  lines.push(`README SHA-256: ${rhwpWasm.readmeSha256}`)
  lines.push(`Scope limitation: ${rhwpWasm.scopeNote}`)
  lines.push('Informative crate-family summary from the installed package README:')
  lines.push('')
  lines.push(rhwpWasm.crateTable)
  lines.push('')

  renderAssetLicense(lines, 'PDF.JS FOXIT STANDARD FONT LICENSE', foxit)
  renderAssetLicense(lines, 'PDF.JS LIBERATION SANS FONT LICENSE', liberation)
  renderAssetLicense(lines, 'PDF.JS ADOBE CMAP LICENSE', cmaps)

  lines.push('='.repeat(78))
  lines.push(`NPM COMPONENT NOTICES (${inventory.packages.length} conservative components)`)
  lines.push('='.repeat(78))
  lines.push('')

  const sortedPackages = [...inventory.packages].sort((left, right) =>
    compareText(
      `${left.name}\0${left.version}\0${left.packagePath}`,
      `${right.name}\0${right.version}\0${right.packagePath}`
    )
  )

  for (const component of sortedPackages) {
    lines.push('-'.repeat(78))
    lines.push(`${component.name}@${component.version}`)
    lines.push('-'.repeat(78))
    lines.push(`Package path: ${component.packagePath}`)
    lines.push(`Scope: ${component.scope}`)
    lines.push(`PURL: ${component.purl}`)
    lines.push(`License metadata: ${component.license}`)
    lines.push(`Integrity: ${component.integrity ?? 'not recorded'}`)
    lines.push(`Resolved archive: ${component.resolved ?? 'not recorded'}`)
    if (component.platformConstrainedOptional) {
      lines.push('License files: metadata-only platform-constrained optional entry (see scope limitation).')
    } else if (component.licenseFiles.length === 0) {
      lines.push('License files: none found at the installed package root; metadata only.')
    } else {
      lines.push(
        `License files: ${component.licenseFiles.map((file) => `${file.path} (SHA-256 ${file.sha256})`).join(', ')}`
      )
      for (const file of component.licenseFiles) {
        lines.push('')
        lines.push(`----- BEGIN ${file.path} -----`)
        lines.push(textBlock(file.content))
        lines.push(`----- END ${file.path} -----`)
      }
    }
    lines.push('')
  }

  if (inventory.unresolved.length > 0) {
    lines.push('='.repeat(78))
    lines.push('UNRESOLVED OPTIONAL OR PEER EDGES')
    lines.push('='.repeat(78))
    for (const edge of inventory.unresolved) {
      lines.push(`${edge.parentPath} -> ${edge.name} (${edge.kind}; no lockfile resolution)`)
    }
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n+$/g, '')}\n`
}

function packageComponent(entry) {
  const component = {
    type: entry.packagePath === ELECTRON_PACKAGE_PATH ? 'framework' : 'library',
    'bom-ref': entry.bomRef,
    name: entry.name,
    version: entry.version,
    purl: entry.purl,
    licenses: licenseChoice(entry.license),
    properties: [
      { name: 'ssgkimchi:inventory:package-path', value: entry.packagePath },
      { name: 'ssgkimchi:inventory:scope', value: entry.scope },
      { name: 'ssgkimchi:npm:dev-flag', value: String(entry.devFlag) },
      { name: 'ssgkimchi:npm:optional', value: String(entry.optional) },
      {
        name: 'ssgkimchi:npm:platform-constrained-optional',
        value: String(entry.platformConstrainedOptional)
      },
      { name: 'ssgkimchi:npm:integrity', value: entry.integrity ?? 'not-recorded' },
      {
        name: 'ssgkimchi:notices:license-files',
        value:
          entry.licenseFiles.length > 0
            ? entry.licenseFiles.map((file) => file.path).join(',')
            : entry.platformConstrainedOptional
              ? 'metadata-only-platform-constrained-optional-entry'
              : 'none-found-at-package-root'
      }
    ]
  }
  if (entry.integrityHash) component.hashes = [entry.integrityHash]
  if (entry.resolved && /^https:\/\//.test(entry.resolved)) {
    component.externalReferences = [{ type: 'distribution', url: entry.resolved }]
  }
  return component
}

function assetComponent(asset) {
  const component = {
    type: asset.type,
    'bom-ref': asset.bomRef,
    name: asset.name,
    version: asset.version,
    licenses: [{ license: { name: asset.licenseName } }],
    properties: [
      { name: 'ssgkimchi:inventory:owner-package-path', value: asset.ownerPath }
    ]
  }
  if (asset.hash) {
    component.hashes = [{ algorithm: 'SHA-256', content: asset.hash.toUpperCase() }]
    component.properties.push({ name: 'ssgkimchi:hash:scope', value: asset.hashScope })
  }
  if (asset.noticePath) {
    // dist 플랫폼 빌드마다 바이트가 달라 해시/크기는 기록하지 않는다 (상세: loadAssets 주석)
    component.properties.push({ name: 'ssgkimchi:notices:path', value: asset.noticePath })
  }
  if (asset.licensePath) {
    component.properties.push(
      { name: 'ssgkimchi:notices:path', value: asset.licensePath },
      { name: 'ssgkimchi:notices:sha256', value: asset.licenseSha256 }
    )
  }
  if (asset.scopeNote) {
    component.properties.push({ name: 'ssgkimchi:inventory:scope-limitation', value: asset.scopeNote })
  }
  component.properties.sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.value, right.value)
  )
  return component
}

export function generateSbom(inventory = loadComplianceInventory()) {
  const components = [
    ...inventory.packages.map(packageComponent),
    ...inventory.assets.map(assetComponent)
  ].sort((left, right) => compareText(left['bom-ref'], right['bom-ref']))

  const ownerAssets = new Map()
  for (const asset of inventory.assets) {
    const existing = ownerAssets.get(asset.ownerPath) ?? []
    existing.push(asset.bomRef)
    ownerAssets.set(asset.ownerPath, existing)
  }

  const directRefs = inventory.productionDirectPaths
    .map((packagePath) => inventory.byPath.get(packagePath)?.bomRef)
    .filter(Boolean)
  const electronRef = inventory.byPath.get(ELECTRON_PACKAGE_PATH)?.bomRef
  if (!electronRef) fail('Electron SBOM reference is missing')
  directRefs.push(electronRef)

  const dependencies = [
    {
      ref: inventory.root.bomRef,
      dependsOn: [...new Set(directRefs)].sort()
    },
    ...inventory.packages.map((entry) => ({
      ref: entry.bomRef,
      dependsOn: [
        ...entry.dependencies.map((dependency) => dependency.bomRef),
        ...(ownerAssets.get(entry.packagePath) ?? [])
      ].sort()
    })),
    ...inventory.assets.map((asset) => ({ ref: asset.bomRef, dependsOn: [] }))
  ].sort((left, right) => compareText(left.ref, right.ref))

  const bom = {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: inventory.serialNumber,
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: 'application',
            name: 'ssgkimchi offline compliance generator',
            version: '1'
          }
        ]
      },
      component: {
        type: 'application',
        'bom-ref': inventory.root.bomRef,
        name: inventory.root.name,
        version: inventory.root.version,
        purl: inventory.root.purl,
        copyright: 'Copyright (c) 2026 싹싹김치',
        licenses: [{ license: { id: 'MIT' } }]
      },
      properties: [
        { name: 'ssgkimchi:generator:deterministic', value: 'true' },
        { name: 'ssgkimchi:generator:network-access', value: 'none' },
        { name: 'ssgkimchi:inventory:fingerprint', value: inventory.fingerprint },
        { name: 'ssgkimchi:inventory:lockfile', value: LOCK_PATH },
        { name: 'ssgkimchi:inventory:lockfile-sha256', value: inventory.lockSha256 },
        {
          name: 'ssgkimchi:inventory:scope',
          value:
            'Conservative package-lock production closure (required, optional, installed peers) plus the shipped Electron runtime and selected non-npm runtime assets.'
        },
        {
          name: 'ssgkimchi:inventory:scope-limitation:chromium',
          value:
            'Chromium internal components are not expanded; consult the hashed Electron LICENSES.chromium.html notice.'
        },
        {
          name: 'ssgkimchi:inventory:scope-limitation:rhwp-wasm',
          value:
            'Rust crates compiled into @rhwp/core WASM are not enumerated by npm metadata; obtain a version-bound upstream crate inventory.'
        },
        {
          name: 'ssgkimchi:inventory:scope-limitation:artifact',
          value:
            'Declared optional dependencies may be overincluded and declared production dependencies may be bundled rather than copied as node_modules; this is not a byte-level installer inventory.'
        }
      ]
    },
    components,
    dependencies
  }

  return `${JSON.stringify(bom, null, 2)}\n`
}

export function parseCheckMode(args) {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--check') return true
  fail(`unsupported arguments: ${args.join(' ')} (only --check is accepted)`)
}

export function writeOrCheckGeneratedFile(repositoryPath, content, check) {
  const expected = Buffer.from(content, 'utf8')
  const outputPath = absolutePath(repositoryPath)
  if (check) {
    let actual
    try {
      actual = readFileSync(outputPath)
    } catch (error) {
      fail(`checked-in output is missing: ${repositoryPath} (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!actual.equals(expected)) {
      fail(`${repositoryPath} is stale; regenerate it without --check`)
    }
    return { mode: 'checked', bytes: expected.length, path: repositoryPath }
  }

  writeFileSync(outputPath, expected)
  return { mode: 'generated', bytes: expected.length, path: repositoryPath }
}
