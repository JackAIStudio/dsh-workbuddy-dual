/**
 * The one preference that decides whether accounts switch by themselves.
 *
 * It lives beside the pool documents rather than inside the Harness settings
 * tree because the settings card that toggles it is served by this plugin over
 * its own loopback route, and a single small file is easier to recover than a
 * section of a shared document.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const WORKBUDDY_ROUTER_FILENAME = '.workbuddy-dual-router.json'

export interface WorkBuddyRouterSettings {
  /** Automatic account switching; on unless the user turns it off. */
  autoRoute: boolean
}

const DEFAULTS: WorkBuddyRouterSettings = { autoRoute: true }

export function normalizeRouterSettings(raw: unknown): WorkBuddyRouterSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const doc = raw as Record<string, unknown>
  return { autoRoute: typeof doc['autoRoute'] === 'boolean' ? doc['autoRoute'] : DEFAULTS.autoRoute }
}

export class WorkBuddyRouterSettingsStore {
  private readonly path: string
  private cached: WorkBuddyRouterSettings | undefined

  constructor(options: { path?: string | undefined } = {}) {
    this.path = options.path ?? join(resolveDshHome(), WORKBUDDY_ROUTER_FILENAME)
  }

  get documentPath(): string {
    return this.path
  }

  /** Cached value, kept warm so the request path never waits on disk. */
  current(): WorkBuddyRouterSettings {
    return this.cached ?? DEFAULTS
  }

  async get(): Promise<WorkBuddyRouterSettings> {
    if (this.cached !== undefined) return this.cached
    try {
      this.cached = normalizeRouterSettings(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      this.cached = { ...DEFAULTS }
    }
    return this.cached
  }

  async set(patch: Partial<WorkBuddyRouterSettings>): Promise<WorkBuddyRouterSettings> {
    const current = await this.get()
    const next: WorkBuddyRouterSettings = {
      autoRoute: patch.autoRoute ?? current.autoRoute,
    }
    await withFileLock(this.path, async () => {
      await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
    this.cached = next
    return next
  }
}
