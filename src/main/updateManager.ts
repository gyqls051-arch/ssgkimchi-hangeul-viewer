import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { isTrustedIpcEvent } from './rendererTrust'
import {
  clearUpdateInstallMarker,
  reconcileUpdateInstallMarker,
  saveUpdateInstallMarker
} from './store'
import {
  autoUpdater,
  CancellationToken,
  NsisUpdater,
  type AppUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
  type VerifyUpdateCodeSignature
} from 'electron-updater'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import releasePolicy from '../../release-policy.json'
import type {
  UpdateErrorCode,
  UpdateSnapshot,
  UpdateSupportReason
} from '../preload/api'

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const CHECK_COOLDOWN_MS = 10_000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 15 * 60_000
const PROGRESS_THROTTLE_MS = 250

interface UpdateManagerOptions {
  publish(snapshot: UpdateSnapshot): void
  prepareInstall(): void
  cancelInstallPreparation(): void
}

interface VersionTuple {
  major: bigint
  minor: bigint
  patch: bigint
}

function parseStableVersion(value: string): VersionTuple | null {
  const match = STABLE_VERSION.exec(value)
  if (!match) return null
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3])
  }
}

function compareVersions(left: VersionTuple, right: VersionTuple): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  return 0
}

function isPlaceholder(value: string): boolean {
  return /^(?:REPLACE|CONFIGURE|CHANGEME|TODO|__)/iu.test(value.trim()) || /[<>]/u.test(value)
}

function parseYamlScalar(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || ['&', '*', '!', '|', '>', '{', '['].includes(trimmed[0])) return null
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return null
    return trimmed.slice(1, -1).replace(/''/gu, "'")
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  return trimmed.includes(' #') ? trimmed.slice(0, trimmed.indexOf(' #')).trimEnd() : trimmed
}

/** electron-builder가 생성한 app-update.yml에서 단일 게시자만 제한적으로 읽는다. */
function readEmbeddedPublisherName(): string | null {
  let source = ''
  try {
    source = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
  } catch {
    return null
  }

  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const index = lines.findIndex((line) => /^publisherName:/u.test(line))
  if (index < 0) return null

  const remainder = lines[index].slice('publisherName:'.length)
  if (remainder.trim()) return parseYamlScalar(remainder)

  const publishers: string[] = []
  for (const line of lines.slice(index + 1)) {
    const match = /^ {2}- (.+)$/u.exec(line)
    if (!match) break
    const parsed = parseYamlScalar(match[1])
    if (!parsed) return null
    publishers.push(parsed)
  }
  return publishers.length === 1 ? publishers[0] : null
}

function classifyError(error: unknown): UpdateErrorCode {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/signature|publisher|authenticode|ERR_UPDATER_INVALID_SIGNATURE/iu.test(text)) {
    return 'signature'
  }
  if (/sha(?:256|512)|checksum|blockmap|latest\.yml|metadata|yaml/iu.test(text)) {
    return 'metadata'
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|network|net::|HTTP|fetch/iu.test(text)) return 'network'
  return 'internal'
}

function boundedPercent(info: ProgressInfo): number {
  const value = Number.isFinite(info.percent) ? info.percent : 0
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

interface AuthenticodeInspection {
  status: string
  subject: string
  thumbprint: string
  timestamped: boolean
  codeSigning: boolean
}

const INSPECT_AUTHENTICODE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$securityModule = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -Force -ErrorAction Stop
$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:SSGKIMCHI_UPDATE_PATH
$certificate = $signature.SignerCertificate
if ($null -eq $certificate) { throw 'Signer certificate is missing' }
$codeSigning = @($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -gt 0
[pscustomobject]@{
  status = [string]$signature.Status
  subject = [string]$certificate.Subject
  thumbprint = [string]$certificate.Thumbprint
  timestamped = $null -ne $signature.TimeStamperCertificate
  codeSigning = $codeSigning
} | ConvertTo-Json -Compress
`

function trustedPowerShellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR']
  if (!systemRoot || !isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('Windows system root is unavailable')
  }
  const root = realpathSync.native(systemRoot)
  const executable = realpathSync.native(
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  )
  const withinRoot = relative(root, executable)
  if (
    !withinRoot ||
    withinRoot === '..' ||
    isAbsolute(withinRoot) ||
    withinRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('Windows PowerShell path escapes the system root')
  }
  const stat = lstatSync(executable)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Windows PowerShell is not a regular system file')
  }
  return executable
}

function inspectAuthenticode(path: string): Promise<AuthenticodeInspection> {
  return new Promise((resolve, reject) => {
    let stat
    let powershell
    try {
      stat = lstatSync(path)
      powershell = trustedPowerShellPath()
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      reject(new Error('Downloaded update is not a regular file'))
      return
    }

    const environment: NodeJS.ProcessEnv = {
      SystemRoot: process.env['SystemRoot'],
      WINDIR: process.env['WINDIR'],
      TEMP: process.env['TEMP'],
      TMP: process.env['TMP'],
      SSGKIMCHI_UPDATE_PATH: path
    }
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', INSPECT_AUTHENTICODE],
      { encoding: 'utf8', env: environment, maxBuffer: 64 * 1024, timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim())
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Authenticode inspection output is invalid')
          }
          const value = parsed as Record<string, unknown>
          if (
            typeof value['status'] !== 'string' ||
            typeof value['subject'] !== 'string' ||
            typeof value['thumbprint'] !== 'string' ||
            typeof value['timestamped'] !== 'boolean' ||
            typeof value['codeSigning'] !== 'boolean'
          ) {
            throw new Error('Authenticode inspection fields are invalid')
          }
          resolve({
            status: value['status'],
            subject: value['subject'],
            thumbprint: value['thumbprint'],
            timestamped: value['timestamped'],
            codeSigning: value['codeSigning']
          })
        } catch (parseError: unknown) {
          reject(parseError instanceof Error ? parseError : new Error(String(parseError)))
        }
      }
    )
  })
}

function exactSignatureVerifier(
  defaultVerifier: VerifyUpdateCodeSignature
): VerifyUpdateCodeSignature {
  const expectedPublisher = releasePolicy.windows.publisherName
  const expectedSubject = releasePolicy.windows.certificateSubject
  const expectedThumbprint = releasePolicy.windows.certificateThumbprint
    .replace(/[\s:-]/gu, '')
    .toUpperCase()

  return async (publisherNames, path) => {
    try {
      if (publisherNames.length !== 1 || publisherNames[0] !== expectedPublisher) {
        return 'Update publisher policy mismatch'
      }
      const defaultFailure = await defaultVerifier(publisherNames, path)
      if (defaultFailure) return 'Default Authenticode publisher verification failed'

      const signature = await inspectAuthenticode(path)
      if (
        signature.status !== 'Valid' ||
        signature.subject !== expectedSubject ||
        signature.thumbprint.replace(/[\s:-]/gu, '').toUpperCase() !== expectedThumbprint ||
        !signature.timestamped ||
        !signature.codeSigning
      ) {
        return 'Exact Authenticode identity verification failed'
      }
      return null
    } catch (error: unknown) {
      console.error('[updater] exact Authenticode verification failed:', error)
      return 'Exact Authenticode verification could not be completed'
    }
  }
}

interface DownloadedInstaller {
  path: string
  version: string
  sha512: string
}

function canonicalSha512(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u.test(value)) {
    return null
  }
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 64 && bytes.toString('base64') === value ? value : null
}

function sha512File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('base64')))
  })
}

function launchInstaller(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['--updated', '--force-run'], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.removeListener('error', reject)
      child.unref()
      resolve()
    })
  })
}

export class UpdateManager {
  private readonly updater: AppUpdater = autoUpdater
  private readonly currentVersion = app.getVersion()
  private readonly currentTuple = parseStableVersion(this.currentVersion)
  private readonly blockedVersions = new Set<string>(releasePolicy.release.blockedVersions)
  private readonly quarantinedVersions = new Set<string>()
  private snapshot: UpdateSnapshot = {
    revision: 0,
    phase: 'unsupported',
    supportReason: 'configuration',
    currentVersion: this.currentVersion
  }
  private initialized = false
  private supported = false
  private disposed = false
  private checkPromise: Promise<unknown> | null = null
  private downloadPromise: Promise<unknown> | null = null
  private cancellationToken: CancellationToken | null = null
  private signatureVerifier: VerifyUpdateCodeSignature | null = null
  private downloadedInstaller: DownloadedInstaller | null = null
  private availableVersion: string | null = null
  private nextCheckAllowedAt = 0
  private failureCount = 0
  private lastProgressAt = 0
  private lastProgressPercent = -1

  constructor(private readonly options: UpdateManagerOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return
    this.initialized = true

    if (!app.isPackaged) {
      this.publishUnsupported('development')
      return
    }
    if (process.platform !== 'win32') {
      this.publishUnsupported('platform')
      return
    }
    const updater = this.updater
    if (!this.hasTrustedConfiguration() || !(updater instanceof NsisUpdater)) {
      this.publishUnsupported('configuration')
      return
    }

    const defaultSignatureVerifier = updater.verifyUpdateCodeSignature.bind(updater)
    this.signatureVerifier = exactSignatureVerifier(defaultSignatureVerifier)
    updater.verifyUpdateCodeSignature = this.signatureVerifier
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.autoRunAppAfterInstall = true
    this.updater.allowPrerelease = false
    this.updater.allowDowngrade = false
    this.updater.disableWebInstaller = true
    this.updater.fullChangelog = false
    this.updater.logger = null

    this.updater.on('checking-for-update', this.onCheckingForUpdate)
    this.updater.on('update-available', this.onUpdateAvailable)
    this.updater.on('update-not-available', this.onUpdateNotAvailable)
    this.updater.on('download-progress', this.onDownloadProgress)
    this.updater.on('update-downloaded', this.onUpdateDownloaded)
    this.updater.on('update-cancelled', this.onUpdateCancelled)
    this.updater.on('error', this.onError)

    this.supported = true
    let previousInstallFailed = false
    try {
      previousInstallFailed = await reconcileUpdateInstallMarker(this.currentVersion)
    } catch (error: unknown) {
      console.error('[updater] install marker reconciliation failed:', error)
      previousInstallFailed = true
    }
    if (previousInstallFailed) this.transition('error', { errorCode: 'install' })
    else this.transition('idle')
  }

  getSnapshot(): UpdateSnapshot {
    return { ...this.snapshot }
  }

  broadcastCurrent(): void {
    this.options.publish(this.getSnapshot())
  }

  isSupported(): boolean {
    return this.supported && !this.disposed
  }

  async checkForUpdates(): Promise<UpdateSnapshot> {
    if (!this.isSupported()) return this.getSnapshot()
    if (this.checkPromise || this.downloadPromise) return this.getSnapshot()
    if (['checking', 'available', 'downloading', 'downloaded', 'installing'].includes(this.snapshot.phase)) {
      return this.getSnapshot()
    }

    const now = Date.now()
    if (now < this.nextCheckAllowedAt) return this.getSnapshot()

    this.availableVersion = null
    this.downloadedInstaller = null
    this.transition('checking')
    const operation = Promise.resolve().then(() => this.updater.checkForUpdates())
    this.checkPromise = operation

    try {
      const result = await operation
      if (this.snapshot.phase === 'checking') {
        if (!result) this.fail('configuration', new Error('Updater configuration is unavailable'))
        else if (result.isUpdateAvailable) this.acceptAvailableVersion(result.updateInfo.version)
        else this.markNoUpdate()
      }
    } catch (error: unknown) {
      if (this.snapshot.phase === 'checking') this.fail(classifyError(error), error)
    } finally {
      if (this.checkPromise === operation) this.checkPromise = null
    }
    return this.getSnapshot()
  }

  async downloadUpdate(): Promise<UpdateSnapshot> {
    if (
      !this.isSupported() ||
      this.getSnapshot().phase !== 'available' ||
      !this.availableVersion ||
      this.downloadPromise
    ) {
      return this.getSnapshot()
    }

    const version = this.availableVersion
    const token = new CancellationToken()
    this.cancellationToken = token
    this.lastProgressAt = 0
    this.lastProgressPercent = -1
    this.transition('downloading', { availableVersion: version, progressPercent: 0 })

    const operation = this.updater.downloadUpdate(token)
    this.downloadPromise = operation
    try {
      await operation
      if (this.snapshot.phase === 'downloading' && !token.cancelled) {
        this.fail('metadata', new Error('Download completed without a verified artifact event'), version)
      }
    } catch (error: unknown) {
      if (token.cancelled) {
        this.transition('available', { availableVersion: version })
      } else if (this.snapshot.phase === 'downloading') {
        this.fail(classifyError(error), error, version)
      }
    } finally {
      if (this.downloadPromise === operation) this.downloadPromise = null
      if (this.cancellationToken === token) this.cancellationToken = null
      token.dispose()
      if (token.cancelled && this.snapshot.phase === 'downloading') {
        this.transition('available', { availableVersion: version })
      }
    }
    return this.getSnapshot()
  }

  cancelDownload(): UpdateSnapshot {
    if (this.snapshot.phase !== 'downloading' || !this.cancellationToken) {
      return this.getSnapshot()
    }
    this.cancellationToken.cancel()
    this.downloadedInstaller = null
    this.transition('downloading', {
      availableVersion: this.availableVersion ?? undefined,
      progressPercent: this.snapshot.progressPercent,
      cancelRequested: true
    })
    return this.getSnapshot()
  }

  async confirmInstall(win: BrowserWindow): Promise<boolean> {
    if (
      !this.isSupported() ||
      this.snapshot.phase !== 'downloaded' ||
      !this.availableVersion ||
      win.isDestroyed()
    ) {
      return false
    }

    const version = this.availableVersion
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '업데이트 설치',
      message: `${version} 업데이트를 설치할까요?`,
      detail: '앱을 종료하고 서명이 검증된 업데이트를 설치한 뒤 다시 실행합니다.',
      buttons: ['재시작 후 설치', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    return (
      result.response === 0 &&
      !win.isDestroyed() &&
      this.snapshot.phase === 'downloaded' &&
      this.availableVersion === version
    )
  }

  async installUpdate(): Promise<UpdateSnapshot> {
    const artifact = this.downloadedInstaller
    const verifier = this.signatureVerifier
    if (
      !this.isSupported() ||
      this.snapshot.phase !== 'downloaded' ||
      !this.availableVersion ||
      !artifact ||
      !verifier ||
      artifact.version !== this.availableVersion
    ) {
      return this.getSnapshot()
    }

    const version = this.availableVersion
    this.transition('installing', { availableVersion: version })
    let failureCode: UpdateErrorCode = 'metadata'
    let markerWritten = false
    let installerStarted = false
    try {
      if (!isAbsolute(artifact.path) || artifact.path.length > 32_768) {
        throw new Error('Downloaded installer path is invalid')
      }
      const stat = lstatSync(artifact.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        throw new Error('Downloaded installer is unavailable')
      }
      const actualSha512 = await sha512File(artifact.path)
      if (actualSha512 !== artifact.sha512) {
        throw new Error('Downloaded installer SHA-512 changed before installation')
      }

      failureCode = 'signature'
      const signatureFailure = await verifier([releasePolicy.windows.publisherName], artifact.path)
      if (signatureFailure) throw new Error(signatureFailure)

      failureCode = 'install'
      await saveUpdateInstallMarker(this.currentVersion, version)
      markerWritten = true
      await launchInstaller(artifact.path)
      installerStarted = true

      // installer process 생성이 확인된 뒤에만 기존 close guard를 해제하고 종료한다.
      this.options.prepareInstall()
      app.quit()
    } catch (error: unknown) {
      if (markerWritten && !installerStarted) {
        await clearUpdateInstallMarker().catch((markerError: unknown) =>
          console.error('[updater] failed to clear install marker:', markerError)
        )
      }
      this.options.cancelInstallPreparation()
      this.fail(failureCode, error, version)
    }
    return this.getSnapshot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.supported = false
    this.cancellationToken?.cancel()
    this.cancellationToken?.dispose()
    this.cancellationToken = null
    this.downloadedInstaller = null

    if (this.initialized) {
      this.updater.removeListener('checking-for-update', this.onCheckingForUpdate)
      this.updater.removeListener('update-available', this.onUpdateAvailable)
      this.updater.removeListener('update-not-available', this.onUpdateNotAvailable)
      this.updater.removeListener('download-progress', this.onDownloadProgress)
      this.updater.removeListener('update-downloaded', this.onUpdateDownloaded)
      this.updater.removeListener('update-cancelled', this.onUpdateCancelled)
      this.updater.removeListener('error', this.onError)
    }
  }

  private hasTrustedConfiguration(): boolean {
    const windowsPolicy = releasePolicy.windows
    if (
      releasePolicy.channel !== 'stable' ||
      releasePolicy.release.allowDowngrade !== false ||
      !this.currentTuple ||
      this.blockedVersions.has(this.currentVersion) ||
      isPlaceholder(windowsPolicy.publisherName) ||
      isPlaceholder(windowsPolicy.certificateSubject) ||
      isPlaceholder(windowsPolicy.certificateThumbprint) ||
      !/^[0-9A-F]{40}$/u.test(
        windowsPolicy.certificateThumbprint.replace(/[\s:-]/gu, '').toUpperCase()
      )
    ) {
      return false
    }
    return readEmbeddedPublisherName() === windowsPolicy.publisherName
  }

  private publishUnsupported(supportReason: UpdateSupportReason): void {
    this.transition('unsupported', { supportReason })
  }

  private transition(
    phase: UpdateSnapshot['phase'],
    details: Omit<UpdateSnapshot, 'revision' | 'phase' | 'currentVersion'> = {}
  ): void {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      phase,
      currentVersion: this.currentVersion,
      ...details
    }
    this.options.publish(this.getSnapshot())
  }

  private acceptAvailableVersion(version: string): void {
    if (!this.currentTuple) {
      this.fail('configuration', new Error('Current version is not stable'))
      return
    }
    const candidate = parseStableVersion(version)
    if (!candidate) {
      this.quarantinedVersions.add(version)
      this.fail('policy', new Error('Prerelease or malformed update version rejected'))
      return
    }
    if (
      compareVersions(candidate, this.currentTuple) <= 0 ||
      this.blockedVersions.has(version) ||
      this.quarantinedVersions.has(version)
    ) {
      this.quarantinedVersions.add(version)
      this.fail('policy', new Error('Blocked or non-increasing update version rejected'))
      return
    }

    this.failureCount = 0
    this.nextCheckAllowedAt = Date.now() + CHECK_COOLDOWN_MS
    this.availableVersion = version
    this.downloadedInstaller = null
    this.transition('available', { availableVersion: version })
  }

  private markNoUpdate(): void {
    this.failureCount = 0
    this.nextCheckAllowedAt = Date.now() + CHECK_COOLDOWN_MS
    this.availableVersion = null
    this.downloadedInstaller = null
    this.transition('no-update')
  }

  private fail(code: UpdateErrorCode, error: unknown, version = this.availableVersion ?? undefined): void {
    console.error(`[updater] ${code}:`, error)
    if ((code === 'signature' || code === 'metadata' || code === 'policy') && version) {
      this.quarantinedVersions.add(version)
    }
    this.failureCount = Math.min(this.failureCount + 1, 10)
    const retryDelay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failureCount - 1))
    this.nextCheckAllowedAt = Date.now() + retryDelay
    this.availableVersion = null
    this.downloadedInstaller = null
    this.transition('error', {
      errorCode: code,
      retryAt: this.nextCheckAllowedAt
    })
  }

  private readonly onCheckingForUpdate = (): void => {
    if (this.isSupported() && this.snapshot.phase !== 'checking') this.transition('checking')
  }

  private readonly onUpdateAvailable = (info: UpdateInfo): void => {
    if (this.isSupported()) this.acceptAvailableVersion(info.version)
  }

  private readonly onUpdateNotAvailable = (): void => {
    if (this.isSupported()) this.markNoUpdate()
  }

  private readonly onDownloadProgress = (info: ProgressInfo): void => {
    if (this.snapshot.phase !== 'downloading' || this.snapshot.cancelRequested) return
    const now = Date.now()
    const percent = boundedPercent(info)
    if (
      percent < 100 &&
      now - this.lastProgressAt < PROGRESS_THROTTLE_MS &&
      Math.abs(percent - this.lastProgressPercent) < 1
    ) {
      return
    }
    this.lastProgressAt = now
    this.lastProgressPercent = percent
    this.transition('downloading', {
      availableVersion: this.availableVersion ?? undefined,
      progressPercent: percent
    })
  }

  private readonly onUpdateDownloaded = (info: UpdateDownloadedEvent): void => {
    const token = this.cancellationToken
    if (
      !this.isSupported() ||
      this.snapshot.phase !== 'downloading' ||
      this.snapshot.cancelRequested ||
      !token ||
      token.cancelled
    ) {
      return
    }
    if (!this.availableVersion || info.version !== this.availableVersion) {
      token.cancel()
      this.fail('policy', new Error('Downloaded update does not match the active operation'), info.version)
      return
    }
    const version = this.availableVersion
    const candidate = parseStableVersion(version)
    if (
      !candidate ||
      !this.currentTuple ||
      compareVersions(candidate, this.currentTuple) <= 0 ||
      this.blockedVersions.has(version) ||
      this.quarantinedVersions.has(version)
    ) {
      this.fail('policy', new Error('Downloaded update failed version policy'), version)
      return
    }
    if (info.files.length !== 1 || info.files[0].isAdminRightsRequired === true) {
      token.cancel()
      this.fail('policy', new Error('Update artifact set does not match the per-user NSIS policy'), version)
      return
    }
    const sha512 = canonicalSha512(info.files[0].sha512)
    if (
      !sha512 ||
      !isAbsolute(info.downloadedFile) ||
      info.downloadedFile.length > 32_768
    ) {
      token.cancel()
      this.fail('metadata', new Error('Downloaded installer metadata is invalid'), version)
      return
    }

    this.availableVersion = version
    this.downloadedInstaller = {
      path: info.downloadedFile,
      version,
      sha512
    }
    this.transition('downloaded', { availableVersion: version })
  }

  private readonly onUpdateCancelled = (): void => {
    if (!this.isSupported() || this.snapshot.phase !== 'downloading') return
    this.transition('available', { availableVersion: this.availableVersion ?? undefined })
  }

  private readonly onError = (error: Error): void => {
    if (!this.isSupported() || this.snapshot.phase === 'error') return
    if (this.cancellationToken?.cancelled) return
    this.fail(classifyError(error), error)
  }
}

/** updater 명령은 현재 신뢰된 top-frame renderer에만 노출한다. */
export function registerUpdateIpc(
  manager: UpdateManager,
  getMainWindow: () => BrowserWindow | null
): void {
  const trusted = (event: Parameters<typeof isTrustedIpcEvent>[0]): boolean =>
    isTrustedIpcEvent(event, getMainWindow)

  ipcMain.handle('update:get-state', (event): UpdateSnapshot | null => {
    if (!trusted(event)) return null
    return manager.getSnapshot()
  })

  ipcMain.handle('update:check', async (event): Promise<UpdateSnapshot | null> => {
    if (!trusted(event)) return null
    return manager.checkForUpdates()
  })

  ipcMain.handle('update:download', async (event): Promise<UpdateSnapshot | null> => {
    if (!trusted(event)) return null
    return manager.downloadUpdate()
  })

  ipcMain.handle('update:cancel', (event): UpdateSnapshot | null => {
    if (!trusted(event)) return null
    return manager.cancelDownload()
  })

  ipcMain.handle('update:install', async (event): Promise<UpdateSnapshot | null> => {
    if (!trusted(event)) return null
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return manager.getSnapshot()

    const approved = await manager.confirmInstall(win)
    if (
      !approved ||
      !trusted(event) ||
      getMainWindow() !== win ||
      win.isDestroyed() ||
      win.webContents.isDestroyed()
    ) {
      return manager.getSnapshot()
    }
    return manager.installUpdate()
  })
}
