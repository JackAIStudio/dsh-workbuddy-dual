/**
 * Dual credential resolution for WorkBuddy CN and WorkBuddy Global.
 *
 * Reads desktop auth files:
 * - CN: CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 * - Global: CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info
 *
 * Each region maintains its own token refresh cache under $DSH_HOME.
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyAuthStatus, WorkBuddyCredential, WorkBuddyRegion } from './types.ts'

export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

export interface RegionStoreOptions {
  region: WorkBuddyRegion
  desktopPathOverride?: string | undefined
  ownPath?: string | undefined
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  refreshMarginMs?: number | undefined
}

const CN_FILENAME = 'workbuddy-desktop.info'
const GLOBAL_FILENAME = 'workbuddy-desktop-ai.info'

const DESKTOP_REL_CN = ['CodeBuddyExtension', 'Data', 'Public', 'auth', CN_FILENAME] as const
const DESKTOP_REL_GLOBAL = ['CodeBuddyExtension', 'Data', 'Public', 'auth', GLOBAL_FILENAME] as const

const OWN_CN_FILENAME = '.workbuddy-dual-cn.json'
const OWN_GLOBAL_FILENAME = '.workbuddy-dual-global.json'

function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

function wslDesktopAuthCandidates(home: string, rel: readonly string[]): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...rel),
    join(roamingAppData, ...rel),
  ]
}

export function defaultDesktopCandidatesFor(region: WorkBuddyRegion): string[] {
  const home = homedir()
  const rel = region === 'cn' ? DESKTOP_REL_CN : DESKTOP_REL_GLOBAL
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...rel)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...rel),
      join(home, 'AppData', 'Roaming', ...rel),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...rel)
    return isWsl() ? [...wslDesktopAuthCandidates(home, rel), linux] : [linux]
  }
  return []
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseWorkBuddyAuth(text: string, defaultRegion: WorkBuddyRegion): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const doc = parsed as Record<string, unknown>
  const auth = (typeof doc['auth'] === 'object' && doc['auth'] !== null ? doc['auth'] : doc) as Record<string, unknown>
  const account = (typeof doc['account'] === 'object' && doc['account'] !== null ? doc['account'] : {}) as Record<string, unknown>

  const accessToken = optionalString(auth['accessToken'])
  if (accessToken === undefined) return undefined

  const refreshToken = optionalString(auth['refreshToken']) ?? ''
  const domain = optionalString(auth['domain']) ?? (defaultRegion === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn')
  const uid = optionalString(account['uid']) ?? optionalString(auth['uid']) ?? ''
  const enterpriseId = optionalString(auth['enterpriseId']) ?? optionalString(account['enterpriseId'])
  const nickname = optionalString(account['nickname']) ?? optionalString(auth['nickname'])

  let expiresAtMs = 0
  const rawExpiresAt = optionalNumber(auth['expiresAt'])
  if (rawExpiresAt !== undefined && rawExpiresAt > 0) {
    expiresAtMs = rawExpiresAt
  } else {
    const expiresInSec = optionalNumber(auth['expiresIn'])
    const lastRefreshTime = optionalNumber(auth['lastRefreshTime']) ?? Date.now()
    if (expiresInSec !== undefined && expiresInSec > 0) {
      expiresAtMs = lastRefreshTime + expiresInSec * 1000
    }
  }

  let refreshExpiresAtMs: number | undefined
  const rawRefreshExpiresAt = optionalNumber(auth['refreshExpiresAt'])
  if (rawRefreshExpiresAt !== undefined && rawRefreshExpiresAt > 0) {
    refreshExpiresAtMs = rawRefreshExpiresAt
  }

  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain,
    uid,
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'desktop',
    region: defaultRegion,
  }
}

interface OwnDocument {
  version: 1
  credential: WorkBuddyCredential
}

export class RegionCredentialStore {
  readonly region: WorkBuddyRegion
  private desktopPathOverride?: string | undefined
  private readonly ownPath: string
  private readonly refresh: RegionStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private inflight?: Promise<WorkBuddyCredential> | undefined

  constructor(options: RegionStoreOptions) {
    this.region = options.region
    this.desktopPathOverride = options.desktopPathOverride
    this.ownPath = options.ownPath ?? join(resolveDshHome(), this.region === 'cn' ? OWN_CN_FILENAME : OWN_GLOBAL_FILENAME)
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 300_000
  }

  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  resolveDesktopCandidates(): string[] {
    if (this.desktopPathOverride) return [this.desktopPathOverride]
    const envKey = this.region === 'cn' ? 'WORKBUDDY_CN_AUTH_FILE' : 'WORKBUDDY_GLOBAL_AUTH_FILE'
    const envVal = process.env[envKey] ?? (this.region === 'cn' ? process.env['WORKBUDDY_AUTH_FILE'] : undefined)
    if (envVal?.trim()) return [envVal.trim()]
    return defaultDesktopCandidatesFor(this.region)
  }

  async desktopFilePresent(): Promise<boolean> {
    for (const p of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(p)).isFile()) return true
      } catch {}
    }
    return false
  }

  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const p of this.resolveDesktopCandidates()) {
      try {
        const text = await readFile(p, 'utf8')
        const cred = parseWorkBuddyAuth(text, this.region)
        if (cred) return cred
      } catch (e) {
        if (!isENOENT(e)) {
          // ignore or continue
        }
      }
    }
    return undefined
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      const text = await readFile(this.ownPath, 'utf8')
      const doc = JSON.parse(text) as OwnDocument
      if (doc && doc.version === 1 && doc.credential) return doc.credential
    } catch {}
    return undefined
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      const doc: OwnDocument = { version: 1, credential }
      await writeFileAtomic(this.ownPath, `${JSON.stringify(doc, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(`workbuddy (${this.region}): no signed-in account found. Please sign in to the WorkBuddy ${this.region === 'cn' ? 'CN' : 'Global'} app.`)
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (!credential.refreshToken) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy (${this.region}): token expired and no refresh token available; sign in again in the app.`)
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs: outcome.expiresInSec !== undefined ? Date.now() + outcome.expiresInSec * 1000 : credential.expiresAtMs,
        ...(outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain }),
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (err) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy (${this.region}): token refresh failed (${String(err)}); sign in again in the app.`)
    }
  }

  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const cred = await this.current()
      if (!cred) return { state: 'signed-out', region: this.region }
      return {
        state: 'signed-in',
        region: this.region,
        expiresAtMs: cred.expiresAtMs,
        ...(cred.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: cred.refreshExpiresAtMs }),
        ...(cred.nickname === undefined ? {} : { nickname: cred.nickname }),
        ...(cred.domain === undefined ? {} : { domain: cred.domain }),
        source: cred.source,
      }
    } catch {
      return { state: 'signed-out', region: this.region }
    }
  }
}

export class WorkBuddyDualCredentialStore {
  readonly cn: RegionCredentialStore
  readonly global: RegionCredentialStore

  constructor(options: {
    refreshCN: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
    refreshGlobal: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
    cnPathOverride?: string | undefined
    globalPathOverride?: string | undefined
  }) {
    this.cn = new RegionCredentialStore({
      region: 'cn',
      desktopPathOverride: options.cnPathOverride,
      refresh: options.refreshCN,
    })
    this.global = new RegionCredentialStore({
      region: 'global',
      desktopPathOverride: options.globalPathOverride,
      refresh: options.refreshGlobal,
    })
  }

  storeFor(region: WorkBuddyRegion): RegionCredentialStore {
    return region === 'cn' ? this.cn : this.global
  }
}
