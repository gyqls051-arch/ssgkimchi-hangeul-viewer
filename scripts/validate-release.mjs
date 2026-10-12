#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const STABLE_TAG_PATTERN = '^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$'
const STABLE_TAG = new RegExp(STABLE_TAG_PATTERN)
const FULL_SHA = /^[0-9a-f]{40}$/i
const REQUIRED_PACKAGE_SCRIPTS = ['ci', 'compliance:check', 'package:win', 'verify:release']

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
  assert(!/[\r\n\0]/u.test(value), `${name} must not contain control line breaks`)
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

function normalizedThumbprint(value) {
  return String(value).replace(/[\s:-]/gu, '').toUpperCase()
}

function requireConfigured(value, name) {
  const configured = requireString(value, name).trim()
  assert(
    !/^(?:REPLACE|CONFIGURE|CHANGEME|TODO|__)/iu.test(configured) &&
      !/[<>]/u.test(configured),
    `${name} is still a placeholder`,
  )
  return configured
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function requireYamlScalar(source, key, expected, name = 'electron-builder.yml') {
  const pattern = new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(key)}:\\s*${escapeRegExp(expected)}\\s*(?:#.*)?$`, 'mu')
  assert(pattern.test(source), `${name} must contain ${key}: ${expected}`)
}

function normalizeRepository(value) {
  const raw = requireString(value, 'repository').trim()
  let slug = raw

  if (/^git@github\.com:/iu.test(slug)) {
    slug = slug.slice('git@github.com:'.length)
  } else if (/^ssh:\/\/git@github\.com\//iu.test(slug)) {
    slug = slug.replace(/^ssh:\/\/git@github\.com\//iu, '')
  } else if (/^https?:\/\/github\.com\//iu.test(slug)) {
    slug = slug.replace(/^https?:\/\/github\.com\//iu, '')
  } else if (/^github:/iu.test(slug)) {
    slug = slug.slice('github:'.length)
  }

  slug = slug.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '')
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug), `unsupported GitHub repository value: ${raw}`)
  return slug.toLowerCase()
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!isRecord(value)) return value

  const result = {}
  for (const key of Object.keys(value).sort()) result[key] = canonicalJson(value[key])
  return result
}

function assertJsonEqual(actual, expected, name) {
  const actualText = JSON.stringify(canonicalJson(actual ?? {}))
  const expectedText = JSON.stringify(canonicalJson(expected ?? {}))
  assert(actualText === expectedText, `${name} differs between package.json and package-lock.json`)
}

function parseStableVersion(version, name) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
  assert(match, `${name} must be a stable semantic version without prefixes or suffixes`)
  return match.slice(1).map((part) => BigInt(part))
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function runGit(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })

  if (options.allowFailure) return result
  assert(result.status === 0, `git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function validatePolicy(policy) {
  assert(policy.schemaVersion === 1, 'release-policy.json schemaVersion must be 1')
  assert(policy.channel === 'stable', 'release channel must be stable')

  const packagePolicy = requireRecord(policy.package, 'policy.package')
  requireString(packagePolicy.name, 'policy.package.name')

  const repository = requireRecord(policy.repository, 'policy.repository')
  const repositorySlug = normalizeRepository(repository.slug)
  assert(normalizeRepository(repository.url) === repositorySlug, 'policy repository URL and slug must match')
  assert(repository.defaultBranch === 'main', 'policy default branch must be main')

  const toolchain = requireRecord(policy.toolchain, 'policy.toolchain')
  assert(toolchain.node === '22.13.0', 'policy Node version must be exactly 22.13.0')
  assert(toolchain.npm === '11.17.0', 'policy npm version must be exactly 11.17.0')

  const release = requireRecord(policy.release, 'policy.release')
  assert(release.tagPattern === STABLE_TAG_PATTERN, `policy tagPattern must be ${STABLE_TAG_PATTERN}`)
  assert(release.allowDowngrade === false, 'policy must prohibit downgrades')
  assert(Array.isArray(release.blockedVersions), 'policy blockedVersions must be an array')
  for (const version of release.blockedVersions) parseStableVersion(requireString(version, 'blocked version'), 'blocked version')

  const rollout = requireRecord(release.rollout, 'policy.release.rollout')
  assert(rollout.defaultPercentage === 100, 'stable rollout default must be 100 percent')
  assert(isRecord(rollout.hotfix), 'policy must document hotfix operations')
  assert(rollout.hotfix.requiresNewVersion === true, 'hotfixes must require a new version')
  assert(isRecord(rollout.yank), 'policy must document yank operations')
  assert(rollout.yank.requiresOperatorApproval === true, 'yanks must require operator approval')

  const legal = requireRecord(release.legal, 'policy.release.legal')
  requireString(legal.license, 'policy.release.legal.license')
  requireString(legal.copyright, 'policy.release.legal.copyright')
  assert(legal.complianceCommand === 'npm run compliance:check', 'legal compliance command must be npm run compliance:check')
  assert(legal.approvalEnvironment === 'production-release', 'legal approval environment must be production-release')

  const target = requireRecord(policy.target, 'policy.target')
  assert(target.platform === 'win32', 'release platform must be win32')
  assert(target.architecture === 'x64', 'release architecture must be x64')
  assert(target.builderTarget === 'nsis', 'release builder target must be nsis')

  const windows = requireRecord(policy.windows, 'policy.windows')
  assert(typeof windows.signing === 'boolean', 'policy.windows.signing must be a boolean')
  const signing = windows.signing
  let publisherName = null
  let certificateSubject = null
  let certificateThumbprint = null
  if (signing) {
    publisherName = requireConfigured(windows.publisherName, 'policy.windows.publisherName')
    certificateSubject = requireConfigured(windows.certificateSubject, 'policy.windows.certificateSubject')
    assert(certificateSubject.includes('='), 'certificate subject must be the exact full distinguished name')
    certificateThumbprint = normalizedThumbprint(
      requireConfigured(windows.certificateThumbprint, 'policy.windows.certificateThumbprint'),
    )
    assert(/^[0-9A-F]{40}$/u.test(certificateThumbprint), 'certificate thumbprint must normalize to 40 hexadecimal characters')
    assert(windows.requireTimestamp === true, 'Authenticode timestamps must be required')
  }
  requireString(windows.productExecutable, 'policy.windows.productExecutable')
  assert(windows.productExecutable.toLowerCase().endsWith('.exe'), 'product executable must be an .exe file')

  const artifacts = requireRecord(policy.artifacts, 'policy.artifacts')
  for (const key of ['installerTemplate', 'blockmapTemplate']) {
    const template = requireString(artifacts[key], `policy.artifacts.${key}`)
    assert(template.includes('{version}'), `${key} must contain {version}`)
    assert(!template.includes('/') && !template.includes('\\'), `${key} must be a basename template`)
  }
  for (const key of ['updateMetadata', 'checksums', 'manifest']) {
    const basename = requireString(artifacts[key], `policy.artifacts.${key}`)
    assert(!basename.includes('/') && !basename.includes('\\'), `${key} must be a basename`)
  }

  return {
    artifacts,
    certificateSubject,
    certificateThumbprint,
    legal,
    packageName: packagePolicy.name,
    publisherName,
    release,
    repository,
    repositorySlug,
    signing,
    toolchain,
    windows,
  }
}

function validatePackageAndLock(packageJson, lock, policyState) {
  const repositoryName = policyState.repositorySlug.split('/')[1]
  assert(packageJson.name === policyState.packageName, 'package name must match release policy')
  assert(packageJson.name === repositoryName, 'package name must match repository name')
  assert(packageJson.name === policyState.artifacts.installerTemplate.split('-{version}')[0], 'installer template must start with package name')
  assert(packageJson.private === true, 'release source package must remain private')

  const packageVersion = requireString(packageJson.version, 'package.json version')
  parseStableVersion(packageVersion, 'package.json version')
  assert(packageJson.license === policyState.legal.license, 'package license must match release legal policy')
  assert(packageJson.engines?.node === `>=${policyState.toolchain.node}`, 'package Node engine must match the exact CI baseline')
  assert(packageJson.packageManager === `npm@${policyState.toolchain.npm}`, 'packageManager must pin the release npm version')

  const scripts = requireRecord(packageJson.scripts, 'package.json scripts')
  for (const scriptName of REQUIRED_PACKAGE_SCRIPTS) {
    requireString(scripts[scriptName], `package.json script ${scriptName}`)
  }
  assert(/\belectron-builder\b/iu.test(scripts['package:win']), 'package:win must invoke electron-builder')
  assert(/--win(?:\s|$)/iu.test(scripts['package:win']), 'package:win must target Windows')
  assert(!/--publish\s+(?:always|onTagOrDraft)/iu.test(scripts['package:win']), 'package:win must not publish')
  assert(/--publish\s+never/iu.test(scripts['package:win']), 'package:win must explicitly use --publish never')

  assert(lock.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3')
  assert(lock.name === packageJson.name, 'package-lock top-level name must match package.json')
  assert(lock.version === packageVersion, 'package-lock top-level version must match package.json')
  const lockRoot = requireRecord(lock.packages?.[''], 'package-lock packages[""]')
  assert(lockRoot.name === packageJson.name, 'package-lock root package name must match package.json')
  assert(lockRoot.version === packageVersion, 'package-lock root package version must match package.json')
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines']) {
    assertJsonEqual(packageJson[field], lockRoot[field], field)
  }

  if (packageJson.repository !== undefined) {
    const packageRepository =
      typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url
    assert(normalizeRepository(packageRepository) === policyState.repositorySlug, 'package repository must match policy')
  }

  return packageVersion
}

function validateBuilder(builder, packageName, policyState) {
  requireYamlScalar(builder, 'copyright', policyState.legal.copyright)
  requireYamlScalar(builder, 'provider', 'github')
  const [owner, repositoryName] = policyState.repositorySlug.split('/')
  requireYamlScalar(builder, 'owner', owner)
  requireYamlScalar(builder, 'repo', repositoryName)
  requireYamlScalar(builder, 'target', 'nsis')
  if (policyState.signing) {
    requireYamlScalar(builder, 'forceCodeSigning', 'true')
    requireYamlScalar(builder, 'signExecutable', 'true')
    requireYamlScalar(builder, 'verifyUpdateCodeSignature', 'true')
    requireYamlScalar(builder, 'publisherName', policyState.publisherName)
    assert(/^\s*-\s*sha256\s*(?:#.*)?$/mu.test(builder), 'electron-builder.yml must sign with SHA-256')
  } else {
    requireYamlScalar(builder, 'forceCodeSigning', 'false')
    requireYamlScalar(builder, 'signExecutable', 'false')
    requireYamlScalar(builder, 'verifyUpdateCodeSignature', 'false')
  }
  assert(/^\s*-\s*x64\s*(?:#.*)?$/mu.test(builder), 'electron-builder.yml must retain the x64 architecture')
  requireYamlScalar(builder, 'artifactName', policyState.artifacts.installerTemplate.replace('{version}', '${version}'))
  assert(new RegExp(`^\\s*productName:\\s*${escapeRegExp(policyState.windows.productExecutable.replace(/\.exe$/iu, ''))}\\s*$`, 'mu').test(builder), 'productName must match the product executable')
  for (const resource of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'PRIVACY.md',
    'SUPPORT.md',
    'sbom.cdx.json',
    'release-policy.json',
  ]) {
    requireYamlScalar(builder, 'from', resource)
    requireYamlScalar(builder, 'to', resource)
  }
  assert(packageName === repositoryName, 'package name must match configured GitHub repository')
}

function validateGit(root, tag, eventSha, repositorySlug, defaultBranch) {
  assert(STABLE_TAG.test(tag), `release tag must match ${STABLE_TAG_PATTERN}`)
  assert(FULL_SHA.test(eventSha), 'release SHA must be a full 40-character commit or tag-object SHA')

  if (process.env.GITHUB_EVENT_NAME) assert(process.env.GITHUB_EVENT_NAME === 'push', 'releases may only run from tag push events')
  if (process.env.GITHUB_REF_TYPE) assert(process.env.GITHUB_REF_TYPE === 'tag', 'release ref must be a tag')
  if (process.env.GITHUB_REF) assert(process.env.GITHUB_REF === `refs/tags/${tag}`, 'GITHUB_REF must identify the release tag')

  const origin = runGit(root, ['remote', 'get-url', 'origin'])
  assert(normalizeRepository(origin) === repositorySlug, 'Git origin must match release policy')

  const clean = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  assert(clean === '', 'release checkout must be clean, including untracked files')

  const headCommit = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase()
  const tagCommit = runGit(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).toLowerCase()
  const eventCommit = runGit(root, ['rev-parse', '--verify', `${eventSha}^{commit}`]).toLowerCase()
  assert(headCommit === tagCommit, 'checked-out HEAD must equal the peeled release tag commit')
  assert(eventCommit === tagCommit, 'event SHA must peel to the release tag commit')

  const remoteBranch = `refs/remotes/origin/${defaultBranch}`
  runGit(root, ['rev-parse', '--verify', `${remoteBranch}^{commit}`])
  const ancestry = runGit(root, ['merge-base', '--is-ancestor', tagCommit, remoteBranch], { allowFailure: true })
  assert(ancestry.status === 0, `release commit must be an ancestor of origin/${defaultBranch}`)

  return tagCommit
}

function assertNoDowngrade(root, candidateTag, candidateVersion, releasePolicy) {
  assert(!releasePolicy.blockedVersions.includes(candidateVersion), `version ${candidateVersion} is blocked by release policy`)
  if (releasePolicy.allowDowngrade) return

  const candidate = parseStableVersion(candidateVersion, 'candidate version')
  const tags = runGit(root, ['tag', '--list', 'v*'])
  for (const tag of tags.split(/\r?\n/u).filter(Boolean)) {
    if (tag === candidateTag || !STABLE_TAG.test(tag)) continue
    const existing = parseStableVersion(tag.slice(1), `existing tag ${tag}`)
    assert(compareVersions(candidate, existing) >= 0, `candidate ${candidateTag} would downgrade from existing ${tag}`)
  }
}

function writeGithubOutputs(path, outputs) {
  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value)
    assert(!/[\r\n\0]/u.test(text), `output ${key} contains an invalid character`)
    appendFileSync(path, `${key}=${text}\n`, 'utf8')
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      policy: { type: 'string' },
      tag: { type: 'string' },
      sha: { type: 'string' },
      repository: { type: 'string' },
      'github-output': { type: 'string' },
    },
    strict: true,
  })

  const root = resolve(values.root ?? process.cwd())
  const policyPath = resolve(root, values.policy ?? 'release-policy.json')
  const policy = readJson(policyPath, 'release-policy.json')
  const policyState = validatePolicy(policy)

  assert(process.version === `v${policyState.toolchain.node}`, `Node must be exactly v${policyState.toolchain.node}`)

  const packageJson = readJson(resolve(root, 'package.json'), 'package.json')
  const lock = readJson(resolve(root, 'package-lock.json'), 'package-lock.json')
  const packageVersion = validatePackageAndLock(packageJson, lock, policyState)
  assert(packageJson.name === policy.package.name, 'package name must match release policy')

  const builder = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')
  validateBuilder(builder, packageJson.name, policyState)

  const tag = values.tag ?? process.env.GITHUB_REF_NAME
  const eventSha = values.sha ?? process.env.GITHUB_SHA
  requireString(tag, 'release tag')
  requireString(eventSha, 'release SHA')
  assert(tag === `v${packageVersion}`, 'tag version must exactly match package.json version')

  const repositoryInput = values.repository ?? process.env.GITHUB_REPOSITORY
  if (process.env.GITHUB_ACTIONS === 'true') requireString(repositoryInput, 'GITHUB_REPOSITORY')
  if (repositoryInput) {
    assert(normalizeRepository(repositoryInput) === policyState.repositorySlug, 'event repository must match release policy')
  }

  const commit = validateGit(
    root,
    tag,
    eventSha,
    policyState.repositorySlug,
    policyState.repository.defaultBranch,
  )
  assertNoDowngrade(root, tag, packageVersion, policyState.release)

  const installer = policyState.artifacts.installerTemplate.replace('{version}', packageVersion)
  const blockmap = policyState.artifacts.blockmapTemplate.replace('{version}', packageVersion)
  const outputs = {
    version: packageVersion,
    tag,
    commit,
    repository: policyState.repositorySlug,
    installer,
    blockmap,
    product_executable: policyState.windows.productExecutable,
    signing: String(policyState.signing),
    publisher_name: policyState.publisherName ?? '',
    certificate_subject: policyState.certificateSubject ?? '',
    certificate_thumbprint: policyState.certificateThumbprint ?? '',
    release_environment: policyState.legal.approvalEnvironment,
  }

  const githubOutput = values['github-output'] ?? process.env.GITHUB_OUTPUT
  if (githubOutput) writeGithubOutputs(githubOutput, outputs)
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.env.GITHUB_ACTIONS === 'true') process.stderr.write(`::error title=Release validation failed::${message.replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}\n`)
  else process.stderr.write(`Release validation failed: ${message}\n`)
  process.exitCode = 1
}
