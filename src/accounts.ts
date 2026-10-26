/**
 * The account pool: several WorkBuddy sign-ins per region, one of them active.
 *
 * Before this file the plugin held exactly one credential per region (the
 * desktop app's sign-in, or the plugin's own refreshed copy of it). That made
 * "switch to the account that can still run flash" a manual file edit. Here we
 * keep a list instead, plus the id of the account the user picked; the active
 * entry is what the credential store resolves.
 *
 * Storage lives next to the plugin's other state under the DSH home, so the
 * desktop and Web hosts read the same document and therefore share the same
 * selection. The document holds live bearer tokens, so it is written with the
 * same 0600/0700 modes the single-credential cache used.
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCredential, WorkBuddyRegion } from './types.ts'

/** One stored sign-in. Tokens are refreshed in place. */
export interface WorkBuddyPoolAccount {
  /** Stable identity: the WorkBuddy uid. */
  uid: string
  region: WorkBuddyRegion
  nickname?: string | undefined
  /** User-supplied label; shown instead of the nickname when present. */
  label?: string | undefined
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number | undefined
  domain: string
  enterpriseId?: string | undefined
  /** First time the pool saw this account. */
  addedAt: number
  /** Last successful token write. */
  updatedAt: number
}

/** Versioned on-disk shape of one region's pool. */
export interface WorkBuddyPoolDocument {
  version: 1
  region: WorkBuddyRegion
  accounts: readonly WorkBuddyPoolAccount[]
  /** `uid` of the account in use; undefined means "fall back to the desktop app". */
  activeUid?: string | undefined
  updatedAt: number
}

export const WORKBUDDY_POOL_FILENAMES: Record<WorkBuddyRegion, string> = {
  cn: '.workbuddy-dual-accounts-cn.json',
  global: '.workbuddy-dual-accounts-global.json',
}

/** Absolute path of one region's pool document. */
export function poolDocumentPath(region: WorkBuddyRegion): string {
  return join(resolveDshHome(), WORKBUDDY_POOL_FILENAMES[region])
}

function emptyDocument(region: WorkBuddyRegion): WorkBuddyPoolDocument {
  return { version: 1, region, accounts: [], updatedAt: 0 }
}

/**
 * A full document with an explicit selection.
 *
 * `activeUid` is optional, so "clear the selection" has to build the object
 * without the key at all; spreading `{ ...doc, activeUid: undefined }` under
 * `exactOptionalPropertyTypes` still counts as present at compile time and
 * would rely on JSON dropping it.
 */
function withAccounts(
  doc: WorkBuddyPoolDocument,
  accounts: readonly WorkBuddyPoolAccount[],
  activeUid: string | undefined,
): WorkBuddyPoolDocument {
  return {
    version: 1,
    region: doc.region,
    accounts,
    ...(activeUid === undefined ? {} : { activeUid }),
    updatedAt: doc.updatedAt,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Accept only a complete entry; a half-written token pair is not an account. */
function normalizeAccount(raw: unknown, region: WorkBuddyRegion): WorkBuddyPoolAccount | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const doc = raw as Record<string, unknown>
  const uid = optionalString(doc['uid'])
  const accessToken = optionalString(doc['accessToken'])
  if (uid === undefined || accessToken === undefined) return undefined
  const now = Date.now()
  const refreshExpiresAtMs = optionalNumber(doc['refreshExpiresAtMs'])
  const addedAt = optionalNumber(doc['addedAt']) ?? now
  return {
    uid,
    region,
    ...(optionalString(doc['nickname']) === undefined ? {} : { nickname: optionalString(doc['nickname']) }),
    ...(optionalString(doc['label']) === undefined ? {} : { label: optionalString(doc['label']) }),
    accessToken,
    refreshToken: optionalString(doc['refreshToken']) ?? '',
    expiresAtMs: optionalNumber(doc['expiresAtMs']) ?? 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(doc['domain']) ?? (region === 'global' ? 'www.workbuddy.ai' : 'www.codebuddy.cn'),
    ...(optionalString(doc['enterpriseId']) === undefined ? {} : { enterpriseId: optionalString(doc['enterpriseId']) }),
    addedAt,
    updatedAt: optionalNumber(doc['updatedAt']) ?? addedAt,
  }
}

/** Reject a document whose region disagrees with its filename. */
export function normalizePoolDocument(raw: unknown, region: WorkBuddyRegion): WorkBuddyPoolDocument {
  if (typeof raw !== 'object' || raw === null) return emptyDocument(region)
  const doc = raw as Record<string, unknown>
  const rawAccounts = Array.isArray(doc['accounts']) ? doc['accounts'] : []
  const accounts: WorkBuddyPoolAccount[] = []
  const seen = new Set<string>()
  for (const item of rawAccounts) {
    const account = normalizeAccount(item, region)
    if (account === undefined || seen.has(account.uid)) continue
    seen.add(account.uid)
    accounts.push(account)
  }
  const activeUid = optionalString(doc['activeUid'])
  return {
    version: 1,
    region,
    accounts,
    ...(activeUid !== undefined && seen.has(activeUid) ? { activeUid } : {}),
    updatedAt: optionalNumber(doc['updatedAt']) ?? 0,
  }
}

/** Turn a pool entry into the credential shape the shim already consumes. */
export function toCredential(account: WorkBuddyPoolAccount): WorkBuddyCredential {
  return {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAtMs: account.expiresAtMs,
    ...(account.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: account.refreshExpiresAtMs }),
    domain: account.domain,
    uid: account.uid,
    ...(account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId }),
    ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
    source: 'pool',
    region: account.region,
  }
}

/** Fold a (possibly refreshed) credential back into its pool entry. */
export function mergeCredential(account: WorkBuddyPoolAccount, credential: WorkBuddyCredential): WorkBuddyPoolAccount {
  return {
    ...account,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
    domain: credential.domain,
    ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
    ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
    updatedAt: Date.now(),
  }
}

/** Reads and writes one region's pool with atomic replacement. */
export class WorkBuddyAccountPool {
  readonly region: WorkBuddyRegion
  private readonly path: string
  private cached: WorkBuddyPoolDocument | undefined
  /** Modification time of the document the cache was read from. */
  private cachedMtimeMs = -1

  constructor(region: WorkBuddyRegion, options: { path?: string | undefined } = {}) {
    this.region = region
    this.path = options.path ?? poolDocumentPath(region)
  }

  /** Absolute document path; surfaced by diagnostics only. */
  get documentPath(): string {
    return this.path
  }

  async get(): Promise<WorkBuddyPoolDocument> {
    const mtimeMs = await stat(this.path).then(file => file.mtimeMs).catch(() => -1)
    if (this.cached !== undefined && mtimeMs === this.cachedMtimeMs) return this.cached
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      this.cached = normalizePoolDocument(raw, this.region)
    } catch {
      this.cached = emptyDocument(this.region)
    }
    // Another host (desktop vs Web) may write the same document; the mtime
    // check keeps this process reading what that host selected.
    this.cachedMtimeMs = mtimeMs
    return this.cached
  }

  /** Re-read from disk on the next `get`; used when another host may have written. */
  invalidate(): void {
    this.cached = undefined
    this.cachedMtimeMs = -1
  }

  /** The account the user selected, if the pool still holds it. */
  async active(): Promise<WorkBuddyPoolAccount | undefined> {
    const doc = await this.get()
    if (doc.activeUid === undefined) return undefined
    return doc.accounts.find(account => account.uid === doc.activeUid)
  }

  async find(uid: string): Promise<WorkBuddyPoolAccount | undefined> {
    const doc = await this.get()
    return doc.accounts.find(account => account.uid === uid)
  }

  /** Persist a whole document after normalizing it against the region. */
  async replace(doc: WorkBuddyPoolDocument): Promise<WorkBuddyPoolDocument> {
    const normalized = normalizePoolDocument({ ...doc, updatedAt: Date.now() }, this.region)
    await withFileLock(this.path, async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
    this.cached = normalized
    this.cachedMtimeMs = await stat(this.path).then(file => file.mtimeMs).catch(() => -1)
    return normalized
  }

  /**
   * Add or replace one account, keeping its `addedAt` and label.
   *
   * Adding through the panel is also how an account becomes selectable, so a
   * first-time add selects it; re-capturing an existing account never steals
   * the selection from whatever the user already chose.
   */
  async upsert(credential: WorkBuddyCredential, options: { select?: boolean | undefined; label?: string | undefined } = {}): Promise<WorkBuddyPoolDocument> {
    const doc = await this.get()
    const existing = doc.accounts.find(account => account.uid === credential.uid)
    const now = Date.now()
    const base: WorkBuddyPoolAccount = existing ?? {
      uid: credential.uid,
      region: this.region,
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs }),
      domain: credential.domain,
      ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
      addedAt: now,
      updatedAt: now,
    }
    const merged = mergeCredential(base, credential)
    const labelled = options.label === undefined ? merged : { ...merged, label: options.label }
    const accounts = existing === undefined
      ? [...doc.accounts, labelled]
      : doc.accounts.map(account => (account.uid === labelled.uid ? labelled : account))
    const select = options.select ?? existing === undefined
    return await this.replace(withAccounts(doc, accounts, select ? labelled.uid : doc.activeUid))
  }

  /** Store a refreshed token pair for one account. */
  async update(uid: string, credential: WorkBuddyCredential): Promise<WorkBuddyPoolDocument | undefined> {
    const doc = await this.get()
    if (!doc.accounts.some(account => account.uid === uid)) return undefined
    return await this.replace({
      ...doc,
      accounts: doc.accounts.map(account => (account.uid === uid ? mergeCredential(account, credential) : account)),
    })
  }

  /** Rename an account (label only; identity stays the uid). */
  async relabel(uid: string, label: string): Promise<WorkBuddyPoolDocument | undefined> {
    const doc = await this.get()
    if (!doc.accounts.some(account => account.uid === uid)) return undefined
    return await this.replace({
      ...doc,
      accounts: doc.accounts.map(account => (account.uid === uid ? { ...account, label } : account)),
    })
  }

  async remove(uid: string): Promise<WorkBuddyPoolDocument> {
    const doc = await this.get()
    const accounts = doc.accounts.filter(account => account.uid !== uid)
    const keepsSelection = doc.activeUid !== undefined && doc.activeUid !== uid
    return await this.replace(withAccounts(doc, accounts, keepsSelection ? doc.activeUid : undefined))
  }

  /** Select an existing account; `undefined` returns to the desktop app's sign-in. */
  async select(uid: string | undefined): Promise<WorkBuddyPoolDocument> {
    const doc = await this.get()
    if (uid !== undefined && !doc.accounts.some(account => account.uid === uid)) {
      throw new Error(`account not in the ${this.region} pool: ${uid}`)
    }
    return await this.replace(withAccounts(doc, doc.accounts, uid))
  }

  /** Drop the whole document, including every stored token. */
  async clear(): Promise<void> {
    await rm(this.path, { force: true })
    await rm(`${this.path}.lock`, { force: true })
    this.cached = emptyDocument(this.region)
    this.cachedMtimeMs = -1
  }
}
