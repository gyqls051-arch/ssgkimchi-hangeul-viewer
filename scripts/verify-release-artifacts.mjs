#!/usr/bin/env node

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const FULL_SHA = /^[0-9a-f]{40}$/iu
const SAFE_BASENAME = /^[^/\\\0\r\n]+$/u

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value, name) {
  assert(isRecord(value), `${name} must be an object`)
  return value
}

function requireString(value, name) {
  assert(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`)
  assert(!/[\0\r\n]/u.test(value), `${name} contains an invalid control character`)
  return value
}

function readJson(path, name) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${name} is not valid JSON: ${error.message}`)
  }
  return requireRecord(parsed, name)
}

function normalizeThumbprint(value) {
  return String(value).replace(/[\s:-]/gu, '').toUpperCase()
}

function requireConfigured(value, name) {
  const configured = requireString(value, name).trim()
  assert(
    !/^(?:REPLACE|CONFIGURE|CHANGEME|TODO|__)/iu.test(configured) && !/[<>]/u.test(configured),
    `${name} is still a placeholder`,
  )
  return configured
}

function compareAscii(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function assertBasename(value, name) {
  requireString(value, name)
  assert(SAFE_BASENAME.test(value), `${name} must be a safe basename`)
  assert(value !== '.' && value !== '..' && basename(value) === value, `${name} must not contain a path`)
  return value
}

function safeJoin(root, ...segments) {
  for (const segment of segments) assertBasename(segment, 'path segment')
  const path = resolve(root, ...segments)
  const pathRelative = relative(resolve(root), path)
  assert(pathRelative !== '' && !pathRelative.startsWith(`..${sep}`) && pathRelative !== '..' && !isAbsolute(pathRelative), 'path escapes its root')
  return path
}

function requireDirectory(path, name) {
  const item = lstatSync(path)
  assert(item.isDirectory() && !item.isSymbolicLink(), `${name} must be a real directory, not a symlink`)
  return realpathSync(path)
}

function requireRegularFile(path, name, containmentRoot) {
  const item = lstatSync(path)
  assert(item.isFile() && !item.isSymbolicLink(), `${name} must be a regular file, not a symlink`)
  if (containmentRoot) {
    const root = realpathSync(containmentRoot)
    const file = realpathSync(path)
    const fileRelative = relative(root, file)
    assert(fileRelative !== '' && !fileRelative.startsWith(`..${sep}`) && fileRelative !== '..' && !isAbsolute(fileRelative), `${name} escapes its expected directory`)
  }
  return item
}

function digest(path, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding)
}

function canonicalBase64(value, expectedBytes, name) {
  requireString(value, name)
  assert(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), `${name} is not canonical Base64`)
  const decoded = Buffer.from(value, 'base64')
  assert(decoded.toString('base64') === value, `${name} is not canonical Base64`)
  if (expectedBytes !== undefined) assert(decoded.length === expectedBytes, `${name} has the wrong decoded length`)
  return decoded
}

function parseYamlScalar(raw, name) {
  assert(raw.length > 0, `${name} must not be empty`)
  if (raw.startsWith("'")) {
    assert(raw.endsWith("'") && raw.length >= 2, `${name} has invalid single quotes`)
    return raw.slice(1, -1).replace(/''/gu, "'")
  }
  if (raw.startsWith('"')) {
    assert(raw.endsWith('"'), `${name} has invalid double quotes`)
    try {
      const parsed = JSON.parse(raw)
      assert(typeof parsed === 'string', `${name} must be a string`)
      return parsed
    } catch (error) {
      fail(`${name} has invalid double-quoted YAML: ${error.message}`)
    }
  }
  assert(!/^[&*!|>{}\[]/u.test(raw), `${name} uses an unsupported YAML feature`)
  assert(!/\s+#/u.test(raw), `${name} must not contain an inline comment`)
  return raw
}

function normalizedYamlLines(path, name) {
  const source = readFileSync(path, 'utf8')
  assert(!source.includes('\0'), `${name} contains a NUL byte`)
  return source.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n')
}

function parseLatestYaml(path) {
  const lines = normalizedYamlLines(path, 'latest.yml')
  assert(lines.length === 8, 'latest.yml must contain exactly the expected fields')

  const captures = [
    [0, /^version: (.+)$/u, 'version'],
    [1, /^files:$/u, 'files'],
    [2, /^  - url: (.+)$/u, 'files[0].url'],
    [3, /^    sha512: (.+)$/u, 'files[0].sha512'],
    [4, /^    size: ([0-9]+)$/u, 'files[0].size'],
    [5, /^path: (.+)$/u, 'path'],
    [6, /^sha512: (.+)$/u, 'sha512'],
    [7, /^releaseDate: (.+)$/u, 'releaseDate'],
  ]

  const values = {}
  for (const [lineIndex, pattern, key] of captures) {
    const match = pattern.exec(lines[lineIndex])
    assert(match, `latest.yml field ${key} is missing or malformed`)
    if (key !== 'files') values[key] = match[1]
  }

  values.version = parseYamlScalar(values.version, 'latest.yml version')
  values['files[0].url'] = parseYamlScalar(values['files[0].url'], 'latest.yml URL')
  values['files[0].sha512'] = parseYamlScalar(values['files[0].sha512'], 'latest.yml file SHA-512')
  values.path = parseYamlScalar(values.path, 'latest.yml path')
  values.sha512 = parseYamlScalar(values.sha512, 'latest.yml SHA-512')
  values.releaseDate = parseYamlScalar(values.releaseDate, 'latest.yml releaseDate')
  values['files[0].size'] = Number(values['files[0].size'])
  assert(Number.isSafeInteger(values['files[0].size']), 'latest.yml size must be a safe integer')
  return values
}

function parseSimpleYamlMapping(path, name) {
  const lines = normalizedYamlLines(path, name)
  const result = {}

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    assert(line.length > 0 && !line.includes('\t'), `${name} contains unsupported whitespace`)
    const match = /^([A-Za-z][A-Za-z0-9]*):(.*)$/u.exec(line)
    assert(match, `${name} line ${index + 1} is not a top-level mapping entry`)
    const key = match[1]
    assert(!(key in result), `${name} contains duplicate key ${key}`)
    const remainder = match[2]

    if (remainder === '') {
      const items = []
      while (index + 1 < lines.length) {
        const itemMatch = /^  - (.+)$/u.exec(lines[index + 1])
        if (!itemMatch) break
        index += 1
        items.push(parseYamlScalar(itemMatch[1], `${name} ${key} item`))
      }
      assert(items.length > 0, `${name} ${key} must be a non-empty sequence`)
      result[key] = items
    } else {
      assert(remainder.startsWith(' '), `${name} ${key} must use one separating space`)
      result[key] = parseYamlScalar(remainder.slice(1), `${name} ${key}`)
    }
  }

  return result
}

function validatePolicy(policy) {
  assert(policy.schemaVersion === 1, 'release policy schemaVersion must be 1')
  assert(policy.channel === 'stable', 'release policy channel must be stable')

  const packagePolicy = requireRecord(policy.package, 'policy.package')
  const repository = requireRecord(policy.repository, 'policy.repository')
  const toolchain = requireRecord(policy.toolchain, 'policy.toolchain')
  const release = requireRecord(policy.release, 'policy.release')
  const target = requireRecord(policy.target, 'policy.target')
  const windows = requireRecord(policy.windows, 'policy.windows')
  const artifacts = requireRecord(policy.artifacts, 'policy.artifacts')

  assert(target.platform === 'win32' && target.architecture === 'x64' && target.builderTarget === 'nsis', 'release target must be Windows x64 NSIS')
  assert(release.allowDowngrade === false, 'release policy must prohibit downgrades')
  assert(Array.isArray(release.blockedVersions), 'release blockedVersions must be an array')
  assert(release.rollout?.defaultPercentage === 100, 'stable rollout must default to 100 percent')
  assert(toolchain.node === '22.13.0' && toolchain.npm === '11.17.0', 'release toolchain versions are not exact')
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.slug), 'repository slug is invalid')

  const publisherName = requireConfigured(windows.publisherName, 'policy.windows.publisherName')
  const certificateSubject = requireConfigured(windows.certificateSubject, 'policy.windows.certificateSubject')
  const certificateThumbprint = normalizeThumbprint(requireConfigured(windows.certificateThumbprint, 'policy.windows.certificateThumbprint'))
  assert(certificateSubject.includes('='), 'certificate subject must be a full distinguished name')
  assert(/^[0-9A-F]{40}$/u.test(certificateThumbprint), 'certificate thumbprint must normalize to 40 hexadecimal characters')
  assert(windows.requireTimestamp === true, 'release policy must require Authenticode timestamps')

  for (const key of ['installerTemplate', 'blockmapTemplate', 'updateMetadata', 'checksums', 'manifest']) {
    assertBasename(artifacts[key], `policy.artifacts.${key}`)
  }
  assert(artifacts.installerTemplate.includes('{version}'), 'installer template must contain {version}')
  assert(artifacts.blockmapTemplate.includes('{version}'), 'blockmap template must contain {version}')
  assertBasename(windows.productExecutable, 'policy.windows.productExecutable')

  return {
    artifacts,
    certificateSubject,
    certificateThumbprint,
    packageName: requireString(packagePolicy.name, 'policy.package.name'),
    publisherName,
    release,
    repository,
    target,
    toolchain,
    windows,
  }
}

function validateSource(root, policyState, tag, commit) {
  const packageJson = readJson(resolve(root, 'package.json'), 'package.json')
  const lock = readJson(resolve(root, 'package-lock.json'), 'package-lock.json')
  assert(packageJson.name === policyState.packageName, 'package name does not match release policy')
  assert(typeof packageJson.version === 'string' && STABLE_VERSION.test(packageJson.version), 'package version must be stable semantic version')
  assert(tag === `v${packageJson.version}`, 'release tag must exactly match package version')
  assert(FULL_SHA.test(commit), 'release commit must be a full 40-character SHA')
  assert(lock.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3')
  assert(lock.name === packageJson.name && lock.version === packageJson.version, 'package-lock top-level identity does not match package.json')
  assert(lock.packages?.['']?.name === packageJson.name && lock.packages?.['']?.version === packageJson.version, 'package-lock root identity does not match package.json')
  assert(!policyState.release.blockedVersions.includes(packageJson.version), 'release version is blocked by policy')

  const electronVersion = requireString(packageJson.devDependencies?.electron, 'package electron version')
  assert(STABLE_VERSION.test(electronVersion), 'Electron version must be exact')
  return { packageJson, lock, version: packageJson.version, electronVersion }
}

function artifactNames(policyState, version) {
  const names = {
    installer: policyState.artifacts.installerTemplate.replace('{version}', version),
    blockmap: policyState.artifacts.blockmapTemplate.replace('{version}', version),
    latest: policyState.artifacts.updateMetadata,
    checksums: policyState.artifacts.checksums,
    manifest: policyState.artifacts.manifest,
  }
  const unique = new Set(Object.values(names))
  assert(unique.size === Object.keys(names).length, 'release artifact names must be unique')
  for (const [key, value] of Object.entries(names)) assertBasename(value, `${key} artifact`)
  return names
}

function validateLatest(path, installerPath, installerName, version) {
  const latest = parseLatestYaml(path)
  const installerStat = requireRegularFile(installerPath, 'installer')
  const installerSha512 = digest(installerPath, 'sha512', 'base64')

  assert(latest.version === version, 'latest.yml version does not match the release version')
  assert(latest['files[0].url'] === installerName, 'latest.yml file URL must be the exact installer basename')
  assert(latest.path === installerName, 'latest.yml path must be the exact installer basename')
  assert(latest['files[0].size'] === installerStat.size, 'latest.yml size does not match the installer byte size')
  canonicalBase64(latest['files[0].sha512'], 64, 'latest.yml file SHA-512')
  canonicalBase64(latest.sha512, 64, 'latest.yml SHA-512')
  assert(latest['files[0].sha512'] === latest.sha512, 'latest.yml SHA-512 fields must be identical')
  assert(latest.sha512 === installerSha512, 'latest.yml SHA-512 does not match the installer')

  const releaseDate = new Date(latest.releaseDate)
  assert(!Number.isNaN(releaseDate.valueOf()), 'latest.yml releaseDate must be a valid date')
  assert(releaseDate.toISOString() === latest.releaseDate, 'latest.yml releaseDate must be canonical ISO-8601 UTC')
  return latest
}

async function validateBlockmap(path, installerPath) {
  const installerStat = requireRegularFile(installerPath, 'blockmap installer')
  const compressed = readFileSync(path)
  assert(compressed.length > 2 && compressed[0] === 0x1f && compressed[1] === 0x8b, 'blockmap must be gzip-compressed')

  let blockmap
  try {
    blockmap = JSON.parse(gunzipSync(compressed).toString('utf8'))
  } catch (error) {
    fail(`blockmap is not valid gzip JSON: ${error.message}`)
  }

  requireRecord(blockmap, 'blockmap')
  assert(blockmap.version === '2', 'blockmap version must be 2')
  assert(Array.isArray(blockmap.files) && blockmap.files.length === 1, 'blockmap must describe exactly one installer file')
  const file = requireRecord(blockmap.files[0], 'blockmap file')
  assert(file.name === 'file', 'blockmap file name must be file')
  assert(file.offset === 0, 'blockmap file offset must be zero')
  assert(Array.isArray(file.sizes) && file.sizes.length > 0, 'blockmap sizes must be non-empty')
  assert(Array.isArray(file.checksums) && file.checksums.length === file.sizes.length, 'blockmap checksums and sizes must have equal length')

  let total = 0n
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index]
    assert(Number.isSafeInteger(size) && size > 0, `blockmap size ${index} must be a positive safe integer`)
    total += BigInt(size)
    canonicalBase64(file.checksums[index], 18, `blockmap checksum ${index}`)
  }
  assert(total === BigInt(installerStat.size), 'blockmap chunk sizes must sum to the installer size')

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'ssgkimchi-blockmap-'))
  const regeneratedPath = join(temporaryDirectory, 'expected.blockmap')
  try {
    let blockmapModule
    try {
      blockmapModule = await import('app-builder-lib/out/targets/blockmap/blockmap.js')
    } catch (error) {
      fail(`locked electron-builder blockmap implementation is unavailable: ${error.message}`)
    }
    const buildBlockMap = blockmapModule.buildBlockMap ?? blockmapModule.default?.buildBlockMap
    assert(typeof buildBlockMap === 'function', 'locked electron-builder blockmap implementation is invalid')
    await buildBlockMap(installerPath, 'gzip', regeneratedPath)
    const regenerated = readFileSync(regeneratedPath)
    assert(compressed.equals(regenerated), 'blockmap content does not exactly match a regeneration from the installer')
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function validateAppUpdate(path, policyState) {
  const appUpdate = parseSimpleYamlMapping(path, 'app-update.yml')
  const allowedKeys = ['owner', 'provider', 'publisherName', 'releaseType', 'repo', 'updaterCacheDirName'].sort(compareAscii)
  assert(JSON.stringify(Object.keys(appUpdate).sort(compareAscii)) === JSON.stringify(allowedKeys), 'app-update.yml contains missing or unexpected fields')

  const [owner, repo] = policyState.repository.slug.split('/')
  assert(appUpdate.provider === 'github', 'app-update.yml provider must be github')
  assert(appUpdate.owner === owner, 'app-update.yml owner does not match policy')
  assert(appUpdate.repo === repo, 'app-update.yml repo does not match policy')
  assert(appUpdate.releaseType === 'release', 'app-update.yml releaseType must be release')
  assert(typeof appUpdate.updaterCacheDirName === 'string' && SAFE_BASENAME.test(appUpdate.updaterCacheDirName), 'app-update.yml updater cache name is invalid')
  const publishers = Array.isArray(appUpdate.publisherName) ? appUpdate.publisherName : [appUpdate.publisherName]
  assert(publishers.length === 1 && publishers[0] === policyState.publisherName, 'app-update.yml publisherName must exactly match release policy')
}

function validateSignatureReport(path, policyState, names) {
  requireRegularFile(path, 'Authenticode signature report')
  const report = readJson(path, 'Authenticode signature report')
  assert(report.schemaVersion === 1, 'signature report schemaVersion must be 1')
  assert(Array.isArray(report.signatures) && report.signatures.length === 2, 'signature report must contain exactly two signatures')

  const expectedFiles = {
    installer: names.installer,
    application: policyState.windows.productExecutable,
  }
  const roles = new Set()
  for (const rawEntry of report.signatures) {
    const entry = requireRecord(rawEntry, 'signature report entry')
    assert(entry.role === 'installer' || entry.role === 'application', 'signature report role is invalid')
    assert(!roles.has(entry.role), `signature report contains duplicate role ${entry.role}`)
    roles.add(entry.role)
    assert(entry.file === expectedFiles[entry.role], `${entry.role} signature report filename is invalid`)
    assert(entry.status === 'Valid', `${entry.role} signature is not Valid`)
    assert(entry.publisherName === policyState.publisherName, `${entry.role} publisher name does not match policy`)
    assert(entry.subject === policyState.certificateSubject, `${entry.role} certificate subject does not match policy`)
    assert(normalizeThumbprint(entry.thumbprint) === policyState.certificateThumbprint, `${entry.role} certificate thumbprint does not match policy`)
    assert(entry.timestamped === true, `${entry.role} signature is not timestamped`)
  }
}

async function validateBuildDirectory(releaseDir, policyState, names, version, signatureReport) {
  requireDirectory(releaseDir, 'release directory')
  const allowedTopLevel = new Set([
    names.installer,
    names.blockmap,
    names.latest,
    'win-unpacked',
    'builder-debug.yml',
    'builder-effective-config.yaml',
  ])
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    assert(allowedTopLevel.has(entry.name), `unexpected release build output: ${entry.name}`)
    assert(!entry.isSymbolicLink(), `release build output must not be a symlink: ${entry.name}`)
    if (entry.name === 'win-unpacked') assert(entry.isDirectory(), 'win-unpacked must be a directory')
    else assert(entry.isFile(), `${entry.name} must be a regular file`)
  }

  const installer = safeJoin(releaseDir, names.installer)
  const blockmap = safeJoin(releaseDir, names.blockmap)
  const latest = safeJoin(releaseDir, names.latest)
  const unpacked = safeJoin(releaseDir, 'win-unpacked')
  const resources = safeJoin(unpacked, 'resources')
  const application = safeJoin(unpacked, policyState.windows.productExecutable)
  const appUpdate = safeJoin(resources, 'app-update.yml')

  requireRegularFile(installer, 'installer', releaseDir)
  requireRegularFile(blockmap, 'blockmap', releaseDir)
  requireRegularFile(latest, 'latest.yml', releaseDir)
  requireDirectory(unpacked, 'win-unpacked')
  requireDirectory(resources, 'win-unpacked resources')
  requireRegularFile(application, 'unpacked application', releaseDir)
  requireRegularFile(appUpdate, 'embedded app-update.yml', releaseDir)

  const latestData = validateLatest(latest, installer, names.installer, version)
  await validateBlockmap(blockmap, installer)
  validateAppUpdate(appUpdate, policyState)
  validateSignatureReport(signatureReport, policyState, names)
  return { installer, blockmap, latest, latestData }
}

function fileMetadata(path, name) {
  const stat = requireRegularFile(path, name)
  assert(Number.isSafeInteger(stat.size), `${name} size is not a safe integer`)
  return {
    name,
    size: stat.size,
    sha256: digest(path, 'sha256'),
    sha512: digest(path, 'sha512', 'base64'),
  }
}

function expectedManifest({ root, assetsDir, names, policy, policyState, source, tag, commit, latest }) {
  const packageLockPath = resolve(root, 'package-lock.json')
  requireRegularFile(packageLockPath, 'package-lock.json')
  const artifacts = [names.installer, names.blockmap, names.latest].map((name) =>
    fileMetadata(safeJoin(assetsDir, name), name),
  )

  return {
    schemaVersion: 1,
    channel: policy.channel,
    package: {
      name: source.packageJson.name,
      version: source.version,
    },
    source: {
      repository: policyState.repository.slug,
      tag,
      commit: commit.toLowerCase(),
      packageLockSha256: digest(packageLockPath, 'sha256'),
    },
    target: {
      platform: policyState.target.platform,
      architecture: policyState.target.architecture,
      builderTarget: policyState.target.builderTarget,
    },
    toolchain: {
      node: policyState.toolchain.node,
      npm: policyState.toolchain.npm,
      electron: source.electronVersion,
    },
    signing: {
      publisherName: policyState.publisherName,
      certificateSubject: policyState.certificateSubject,
      certificateThumbprint: policyState.certificateThumbprint,
      timestamped: true,
    },
    updateMetadata: {
      version: latest.version,
      path: latest.path,
      size: latest['files[0].size'],
      sha512: latest.sha512,
      releaseDate: latest.releaseDate,
    },
    artifacts,
  }
}

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function checksumBytes(assetsDir, names) {
  const covered = [names.installer, names.blockmap, names.latest, names.manifest].sort(compareAscii)
  const lines = covered.map((name) => `${digest(safeJoin(assetsDir, name), 'sha256')}  ${name}`)
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

function assertExactAssets(assetsDir, names) {
  requireDirectory(assetsDir, 'release assets directory')
  const expected = Object.values(names).sort(compareAscii)
  const entries = readdirSync(assetsDir, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).sort(compareAscii)
  assert(JSON.stringify(actual) === JSON.stringify(expected), `release assets must be exactly: ${expected.join(', ')}`)
  for (const entry of entries) {
    assert(entry.isFile() && !entry.isSymbolicLink(), `release asset must be a regular file: ${entry.name}`)
    requireRegularFile(safeJoin(assetsDir, entry.name), `release asset ${entry.name}`, assetsDir)
  }
}

async function verifyAssets({ root, assetsDir, names, policy, policyState, source, tag, commit }) {
  assertExactAssets(assetsDir, names)
  const installer = safeJoin(assetsDir, names.installer)
  const latestPath = safeJoin(assetsDir, names.latest)
  const blockmap = safeJoin(assetsDir, names.blockmap)
  const latest = validateLatest(latestPath, installer, names.installer, source.version)
  await validateBlockmap(blockmap, installer)

  const expected = expectedManifest({ root, assetsDir, names, policy, policyState, source, tag, commit, latest })
  const actualManifest = readFileSync(safeJoin(assetsDir, names.manifest))
  assert(actualManifest.equals(manifestBytes(expected)), 'release-manifest.json is not the deterministic expected manifest')

  const actualChecksums = readFileSync(safeJoin(assetsDir, names.checksums))
  assert(actualChecksums.equals(checksumBytes(assetsDir, names)), 'SHA256SUMS is not the deterministic expected checksum file')
  return expected
}

function prepareOutputDirectory(assetsDir, root, releaseDir) {
  const output = resolve(assetsDir)
  const filesystemRoot = parse(output).root
  assert(output !== filesystemRoot, 'refusing to use a filesystem root as the assets directory')
  assert(output !== resolve(root), 'refusing to use the source root as the assets directory')
  assert(output !== resolve(releaseDir), 'assets directory must differ from the release build directory')
  assert(dirname(output) !== output, 'assets directory has no safe parent')
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      policy: { type: 'string' },
      'release-dir': { type: 'string' },
      'assets-dir': { type: 'string' },
      'signature-report': { type: 'string' },
      tag: { type: 'string' },
      sha: { type: 'string' },
    },
    strict: true,
  })

  assert(positionals.length === 1 && (positionals[0] === 'prepare' || positionals[0] === 'verify'), 'usage: verify-release-artifacts.mjs <prepare|verify> [options]')
  const mode = positionals[0]
  const root = resolve(values.root ?? process.cwd())
  const releaseDir = resolve(root, values['release-dir'] ?? 'release')
  const assetsDir = resolve(root, values['assets-dir'] ?? 'release-assets')
  const policy = readJson(resolve(root, values.policy ?? 'release-policy.json'), 'release-policy.json')
  const policyState = validatePolicy(policy)
  const tag = values.tag ?? process.env.GITHUB_REF_NAME
  const commit = values.sha ?? process.env.RELEASE_COMMIT ?? process.env.GITHUB_SHA
  requireString(tag, 'release tag')
  requireString(commit, 'release commit')
  const source = validateSource(root, policyState, tag, commit)
  const names = artifactNames(policyState, source.version)

  if (mode === 'prepare') {
    const signatureReport = values['signature-report']
    requireString(signatureReport, '--signature-report')
    const build = await validateBuildDirectory(
      releaseDir,
      policyState,
      names,
      source.version,
      resolve(root, signatureReport),
    )
    prepareOutputDirectory(assetsDir, root, releaseDir)
    for (const key of ['installer', 'blockmap', 'latest']) {
      copyFileSync(build[key], safeJoin(assetsDir, names[key]))
    }

    const manifest = expectedManifest({
      root,
      assetsDir,
      names,
      policy,
      policyState,
      source,
      tag,
      commit,
      latest: build.latestData,
    })
    writeFileSync(safeJoin(assetsDir, names.manifest), manifestBytes(manifest), { flag: 'wx' })
    writeFileSync(safeJoin(assetsDir, names.checksums), checksumBytes(assetsDir, names), { flag: 'wx' })
  }

  const manifest = await verifyAssets({ root, assetsDir, names, policy, policyState, source, tag, commit })
  process.stdout.write(`${JSON.stringify({ mode, assets: Object.values(names), manifest }, null, 2)}\n`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.env.GITHUB_ACTIONS === 'true') process.stderr.write(`::error title=Release artifact verification failed::${message.replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}\n`)
  else process.stderr.write(`Release artifact verification failed: ${message}\n`)
  process.exitCode = 1
}
