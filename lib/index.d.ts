import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/types.d.ts
type WorkBuddyRegion = 'cn' | 'global';
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number | undefined;
  domain: string;
  uid: string;
  enterpriseId?: string | undefined;
  nickname?: string | undefined;
  /**
   * Where this credential came from. `pool` means it is one entry of the
   * plugin's own account list, which the user picks from in the settings card.
   */
  source: 'desktop' | 'dsh' | 'pool';
  region: WorkBuddyRegion;
}
type WorkBuddyAuthStatus = {
  state: 'signed-out';
  region: WorkBuddyRegion;
} | {
  state: 'signed-in';
  region: WorkBuddyRegion;
  expiresAtMs: number;
  refreshExpiresAtMs?: number | undefined;
  nickname?: string | undefined;
  domain?: string | undefined;
  source: 'desktop' | 'dsh' | 'pool';
};
interface WorkBuddyCreditAccount {
  name: string;
  balance: number;
  total: number;
}
interface WorkBuddyCredits {
  accounts: readonly WorkBuddyCreditAccount[];
  totalBalance: number;
}
interface WorkBuddyModelReasoning {
  supports: boolean;
  onlyReasoning?: boolean | undefined;
  supportedEfforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
  canDisableThinking?: boolean | undefined;
}
interface WorkBuddyModelBilling {
  credits?: string | undefined;
  badges?: readonly string[] | undefined;
  free: boolean;
}
interface WorkBuddyModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  reasoning?: WorkBuddyModelReasoning | undefined;
  billing?: WorkBuddyModelBilling | undefined;
  region: WorkBuddyRegion;
}
/**
 * Result of asking the upstream whether one model can run *right now* on one
 * account. `ok` means a real (one-token) request was accepted; the other
 * verdicts are the exact reasons it was not.
 */
type WorkBuddyProbeVerdict = 'ok' | 'rate-limited' | 'banned' | 'no-credit' | 'auth' | 'error';
interface WorkBuddyProbeResult {
  verdict: WorkBuddyProbeVerdict;
  /** Upstream business code when the gateway supplied one (6004, 11140, …). */
  code?: string | undefined;
  /** When a rate limit lifts, in epoch milliseconds; parsed from the message. */
  resetsAtMs?: number | undefined;
  /** Short, token-free explanation for the panel. */
  detail?: string | undefined;
  /** How long the probe took. */
  elapsedMs: number;
  checkedAt: number;
}
//#endregion
//#region src/model-paths.d.ts
type WorkBuddyLaneMode = 'all' | 'selected';
/** Stored per-lane preference. `all` ignores `models`; `selected` uses them. */
interface WorkBuddyLanePreference {
  enabled: boolean;
  mode: WorkBuddyLaneMode;
  models: readonly string[];
}
//#endregion
//#region src/selection.d.ts
type WorkBuddyDualSelection = Record<WorkBuddyRegion, WorkBuddyLanePreference>;
/** Fresh selection for a deployment with no stored preference. */
declare function defaultSelection(): WorkBuddyDualSelection;
/** Normalize one lane: de-duplicated trimmed ids, `all` carries no list. */
declare function normalizeLanePreference(input: unknown): WorkBuddyLanePreference;
/** Normalize a whole selection document, keeping valid per-lane defaults. */
declare function normalizeSelection(input: unknown): WorkBuddyDualSelection;
/** Filter one lane's full catalog into what the model pickers should show. */
declare function filterModels(models: readonly WorkBuddyModelInfo[], lane: WorkBuddyLanePreference): readonly WorkBuddyModelInfo[];
/** The exact ids a lane currently advertises, for tests and diagnostics. */
declare function advertisedModelIds(models: readonly WorkBuddyModelInfo[], lane: WorkBuddyLanePreference): string[];
//#endregion
//#region src/catalog.d.ts
declare class WorkBuddyDualCatalog {
  private cnModels;
  private globalModels;
  private live;
  private selection;
  /** Every model the upstream catalogs know about, before user filtering. */
  modelsFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[];
  /** Models the harness is allowed to advertise; optional when open. */
  selectedModelsFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[];
  setSelection(selection: WorkBuddyDualSelection): void;
  /** Whether the upstream catalog has answered for this lane (vs. fallback). */
  isLive(region: WorkBuddyRegion): boolean;
  setModels(region: WorkBuddyRegion, models: readonly WorkBuddyModelInfo[]): void;
}
//#endregion
//#region src/accounts.d.ts
/** One stored sign-in. Tokens are refreshed in place. */
interface WorkBuddyPoolAccount {
  /** Stable identity: the WorkBuddy uid. */
  uid: string;
  region: WorkBuddyRegion;
  nickname?: string | undefined;
  /** User-supplied label; shown instead of the nickname when present. */
  label?: string | undefined;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number | undefined;
  domain: string;
  enterpriseId?: string | undefined;
  /** First time the pool saw this account. */
  addedAt: number;
  /** Last successful token write. */
  updatedAt: number;
}
/** Versioned on-disk shape of one region's pool. */
interface WorkBuddyPoolDocument {
  version: 1;
  region: WorkBuddyRegion;
  accounts: readonly WorkBuddyPoolAccount[];
  /** `uid` of the account in use; undefined means "fall back to the desktop app". */
  activeUid?: string | undefined;
  updatedAt: number;
}
/** Reads and writes one region's pool with atomic replacement. */
declare class WorkBuddyAccountPool {
  readonly region: WorkBuddyRegion;
  private readonly path;
  private cached;
  /** Modification time of the document the cache was read from. */
  private cachedMtimeMs;
  constructor(region: WorkBuddyRegion, options?: {
    path?: string | undefined;
  });
  /** Absolute document path; surfaced by diagnostics only. */
  get documentPath(): string;
  get(): Promise<WorkBuddyPoolDocument>;
  /** Re-read from disk on the next `get`; used when another host may have written. */
  invalidate(): void;
  /** The account the user selected, if the pool still holds it. */
  active(): Promise<WorkBuddyPoolAccount | undefined>;
  find(uid: string): Promise<WorkBuddyPoolAccount | undefined>;
  /** Persist a whole document after normalizing it against the region. */
  replace(doc: WorkBuddyPoolDocument): Promise<WorkBuddyPoolDocument>;
  /**
   * Add or replace one account, keeping its `addedAt` and label.
   *
   * Adding through the panel is also how an account becomes selectable, so a
   * first-time add selects it; re-capturing an existing account never steals
   * the selection from whatever the user already chose.
   */
  upsert(credential: WorkBuddyCredential, options?: {
    select?: boolean | undefined;
    label?: string | undefined;
  }): Promise<WorkBuddyPoolDocument>;
  /** Store a refreshed token pair for one account. */
  update(uid: string, credential: WorkBuddyCredential): Promise<WorkBuddyPoolDocument | undefined>;
  /** Rename an account (label only; identity stays the uid). */
  relabel(uid: string, label: string): Promise<WorkBuddyPoolDocument | undefined>;
  remove(uid: string): Promise<WorkBuddyPoolDocument>;
  /** Select an existing account; `undefined` returns to the desktop app's sign-in. */
  select(uid: string | undefined): Promise<WorkBuddyPoolDocument>;
  /** Drop the whole document, including every stored token. */
  clear(): Promise<void>;
}
//#endregion
//#region src/auth.d.ts
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
interface RegionStoreOptions {
  region: WorkBuddyRegion;
  desktopPathOverride?: string | undefined;
  ownPath?: string | undefined;
  /**
   * The user's account list. When it holds a selected account, that account
   * wins over both the desktop app's sign-in and the plugin's own cache: the
   * selection is an explicit instruction, not a tiebreak.
   */
  pool?: WorkBuddyAccountPool | undefined;
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  refreshMarginMs?: number | undefined;
}
declare class RegionCredentialStore {
  readonly region: WorkBuddyRegion;
  private desktopPathOverride?;
  private readonly ownPath;
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly poolRef;
  private inflight?;
  constructor(options: RegionStoreOptions);
  /** The pool, when this store was built with one. */
  get pool(): WorkBuddyAccountPool | undefined;
  setDesktopPath(path: string | undefined): void;
  resolveDesktopCandidates(): string[];
  desktopFilePresent(): Promise<boolean>;
  private readDesktop;
  private readOwn;
  private saveOwn;
  logout(): Promise<void>;
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * The sign-in the plugin would use with no pool selection: the desktop
   * app's credential, or this plugin's own refreshed copy of it.
   *
   * Kept separate from `current()` so the panel can describe the fallback row
   * honestly while a pooled account is in use.
   */
  fallback(): Promise<WorkBuddyCredential | undefined>;
  private needsRefresh;
  resolve(): Promise<WorkBuddyCredential>;
  private refreshNow;
  status(): Promise<WorkBuddyAuthStatus>;
}
declare class WorkBuddyDualCredentialStore {
  readonly cn: RegionCredentialStore;
  readonly global: RegionCredentialStore;
  readonly pools: Record<WorkBuddyRegion, WorkBuddyAccountPool>;
  constructor(options: {
    refreshCN: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
    refreshGlobal: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
    cnPathOverride?: string | undefined;
    globalPathOverride?: string | undefined;
    /** Pool document paths; tests point these at a temp directory. */
    poolPaths?: Partial<Record<WorkBuddyRegion, string>> | undefined;
  });
  storeFor(region: WorkBuddyRegion): RegionCredentialStore;
  poolFor(region: WorkBuddyRegion): WorkBuddyAccountPool;
}
//#endregion
//#region src/upstream.d.ts
type UpstreamErrorKind = 'auth' | 'credit' | 'rate' | 'client' | 'server' | 'not_found';
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
declare class WorkBuddyUpstreamClient {
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /**
   * Ask the gateway whether `model` runs on this account right now.
   *
   * This sends a real, one-token streaming request instead of reading credits:
   * a rate limit is per model, so the balance says nothing about whether
   * flash is available. Streaming is required — the CN gateway rejects
   * non-stream requests for these models with 11101.
   *
   * The first SSE frame already carries the verdict, so the body is cancelled
   * immediately: a blocked account streams one error frame and a healthy one
   * streams its first delta, and neither needs the rest.
   */
  probeModel(credential: WorkBuddyCredential, model: string): Promise<WorkBuddyProbeResult>;
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyModelInfo[]>;
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
}
//#endregion
//#region src/shim.d.ts
interface WorkBuddyDualShim {
  readonly origin: string;
  readonly ready: Promise<void>;
  baseUrl(region: WorkBuddyRegion): string;
  close(): Promise<void>;
}
interface WorkBuddyDualShimOptions {
  store: WorkBuddyDualCredentialStore;
  client: WorkBuddyUpstreamClient;
  catalog: WorkBuddyDualCatalog;
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}
declare function createWorkBuddyDualShim(options: WorkBuddyDualShimOptions): WorkBuddyDualShim;
//#endregion
//#region src/adapter.d.ts
declare const WORKBUDDY_CN_PROVIDER = "workbuddy-cn";
declare const WORKBUDDY_GLOBAL_PROVIDER = "workbuddy-global";
interface WorkBuddyDualAdapterOptions {
  shim: WorkBuddyDualShim;
  catalog: WorkBuddyDualCatalog;
  resolveAttachments?: () => AttachmentStore | undefined;
  /**
   * Map one absolute host path into the current tool execution world.
   *
   * Without this, PiAiAdapter cannot resolve a readable path for an attached
   * image, so the model-facing handle degrades to metadata only and the agent
   * has to hunt the attachment store on disk to see a picture that was already
   * in its own context. Mirrors the wiring `dsh-llm-pi-ai` applies to its own
   * adapter: `(hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath)`.
   */
  mapHostPath?: (hostPath: string) => string | undefined;
}
interface WorkBuddyDualAdapter {
  adapter: PiAiAdapter;
  invalidate: () => void;
}
declare function createWorkBuddyDualAdapter(options: WorkBuddyDualAdapterOptions): WorkBuddyDualAdapter;
//#endregion
//#region src/selection-store.d.ts
interface WorkBuddyDualSelectionStoreOptions {
  /** Override the document path (tests and unusual deployments). */
  path?: string | undefined;
}
/** Reads and writes the selection document with atomic replacement. */
declare class WorkBuddyDualSelectionStore {
  private readonly path;
  private cached;
  private loaded;
  constructor(options?: WorkBuddyDualSelectionStoreOptions);
  /** Absolute document path; surfaced by diagnostics only. */
  get documentPath(): string;
  /** Current selection, refreshing from disk when it might have changed. */
  get(): Promise<WorkBuddyDualSelection>;
  /** Persist a whole selection after normalizing it. */
  replace(selection: WorkBuddyDualSelection): Promise<WorkBuddyDualSelection>;
  /** Merge one lane's patch into the stored preference. */
  updateLanes(patch: {
    cn?: Partial<WorkBuddyLanePreference> | undefined;
    global?: Partial<WorkBuddyLanePreference> | undefined;
  }): Promise<WorkBuddyDualSelection>;
  private load;
}
//#endregion
//#region src/index.d.ts
declare const WORKBUDDY_DUAL_SETTINGS_NS = "workbuddy-dual";
interface WorkBuddyDualConfig {
  cnAuthFile?: string;
  globalAuthFile?: string;
}
declare const Config: z<WorkBuddyDualConfig>;
declare const name = "dsh-workbuddy-dual";
declare const inject: readonly ["llm"];
declare function apply(ctx: Context, config?: WorkBuddyDualConfig): void;
//#endregion
export { Config, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_GLOBAL_PROVIDER, WorkBuddyDualCatalog, WorkBuddyDualConfig, WorkBuddyDualCredentialStore, type WorkBuddyDualSelection, WorkBuddyDualSelectionStore, WorkBuddyUpstreamClient, advertisedModelIds, apply, createWorkBuddyDualAdapter, createWorkBuddyDualShim, defaultSelection, filterModels, inject, name, normalizeLanePreference, normalizeSelection };