/**
 * Durable storage for the user's per-lane model selection.
 *
 * The document lives beside the plugin's other state under the DSH home. It is
 * deliberately separate from the Harness settings document: the model page is
 * served by this plugin over its own loopback route, which works on both the
 * Web and desktop hosts, and a single small file is easier to recover than a
 * filed-down section of a shared settings tree.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { normalizeSelection, defaultSelection, type WorkBuddyDualSelection } from './selection.ts'
import type { WorkBuddyLanePreference, WorkBuddyStoredSelection } from './model-paths.ts'

export const WORKBUDDY_DUAL_SELECTION_FILENAME = '.workbuddy-dual-models.json'

/** Default absolute path of the selection document. */
export function selectionDocumentPath(): string {
  return join(resolveDshHome(), WORKBUDDY_DUAL_SELECTION_FILENAME)
}

export interface WorkBuddyDualSelectionStoreOptions {
  /** Override the document path (tests and unusual deployments). */
  path?: string | undefined
}

/** Reads and writes the selection document with atomic replacement. */
export class WorkBuddyDualSelectionStore {
  private readonly path: string
  private cached: WorkBuddyDualSelection = defaultSelection()
  private loaded = false

  constructor(options: WorkBuddyDualSelectionStoreOptions = {}) {
    this.path = options.path ?? selectionDocumentPath()
  }

  /** Absolute document path; surfaced by diagnostics only. */
  get documentPath(): string {
    return this.path
  }

  /** Current selection, refreshing from disk when it might have changed. */
  async get(): Promise<WorkBuddyDualSelection> {
    await this.load()
    return this.cached
  }

  /** Persist a whole selection after normalizing it. */
  async replace(selection: WorkBuddyDualSelection): Promise<WorkBuddyDualSelection> {
    await this.load()
    const normalized = normalizeSelection(selection)
    const doc: WorkBuddyStoredSelection = {
      version: 1,
      ...normalized,
      updatedAt: Date.now(),
    }
    await withFileLock(this.path, async () => {
      await writeFileAtomic(this.path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
    this.cached = normalized
    return normalized
  }

  /** Merge one lane's patch into the stored preference. */
  async updateLanes(patch: { cn?: Partial<WorkBuddyLanePreference> | undefined; global?: Partial<WorkBuddyLanePreference> | undefined }): Promise<WorkBuddyDualSelection> {
    const current = await this.get()
    const next: WorkBuddyDualSelection = {
      cn: patch.cn === undefined ? current.cn : { ...current.cn, ...patch.cn },
      global: patch.global === undefined ? current.global : { ...current.global, ...patch.global },
    }
    return this.replace(next)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cached = normalizeSelection(parsed)
    } catch {
      this.cached = defaultSelection()
    }
    this.loaded = true
  }
}
