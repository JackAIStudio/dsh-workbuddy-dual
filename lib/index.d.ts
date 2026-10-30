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
/** Absolute path of one region's pool document. */
declare function poolDocumentPath(region: WorkBuddyRegion): string;
/** Turn a pool entry into the credential shape the shim already consumes. */
declare function toCredential(account: WorkBuddyPoolAccount): WorkBuddyCredential;
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
//#region src/health.d.ts
declare const WORKBUDDY_HEALTH_FILENAME = ".workbuddy-dual-health.json";
interface WorkBuddyHealthEntry {
  verdict: WorkBuddyProbeVerdict;
  /** Epoch ms after which the account may be tried again. */
  cooldownUntilMs: number;
  checkedAt: number;
  detail?: string | undefined;
}
declare function healthKey(region: WorkBuddyRegion, uid: string, model: string): string;
/** How long a verdict keeps an account out of rotation. */
declare function cooldownFor(verdict: WorkBuddyProbeVerdict, resetsAtMs: number | undefined, now?: number): number;
interface WorkBuddyHealthStoreOptions {
  path?: string | undefined;
  now?: (() => number) | undefined;
}
/** Reads and writes the availability document with atomic replacement. */
declare class WorkBuddyHealthStore {
  private readonly path;
  private readonly now;
  private entries;
  private loaded;
  private loading;
  /** Serializes writes so two fast verdicts cannot interleave a whole file. */
  private writing;
  constructor(options?: WorkBuddyHealthStoreOptions);
  /** Absolute document path; diagnostics only. */
  get documentPath(): string;
  /** Whether this account is still cooling down for this model. */
  isBlocked(region: WorkBuddyRegion, uid: string, model: string): Promise<boolean>;
  get(region: WorkBuddyRegion, uid: string, model: string): Promise<WorkBuddyHealthEntry | undefined>;
  /** Every verdict that still applies, for the settings panel. */
  snapshot(): Promise<Record<string, WorkBuddyHealthEntry>>;
  /**
   * Remember what the gateway just said about this account and model.
   *
   * `ok` clears a stored cooldown, which is how an account rejoins rotation
   * after a successful retry instead of waiting for its timer to run out.
   */
  record(region: WorkBuddyRegion, uid: string, model: string, verdict: WorkBuddyProbeVerdict, extra?: {
    resetsAtMs?: number | undefined;
    detail?: string | undefined;
  }): Promise<void>;
  /** Forget one account's verdicts, e.g. after a manual re-check or sign-in. */
  clear(region: WorkBuddyRegion, uid?: string): Promise<void>;
  private flush;
  private load;
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
//#region src/router.d.ts
/** Regions in the order the router tries them. */
declare const REGION_ORDER: readonly WorkBuddyRegion[];
interface WorkBuddyRouteCandidate {
  region: WorkBuddyRegion;
  uid: string;
  credential: WorkBuddyCredential;
  /** `fallback` is the WorkBuddy app's own sign-in rather than a pool entry. */
  source: 'pool' | 'fallback';
  label: string;
  credits?: number | undefined;
}
interface WorkBuddyRouteRequest {
  model: string;
  /** Stable per conversation; the chosen account sticks to it. */
  sessionKey?: string | undefined;
  /** Accounts that already failed this request and must not be retried. */
  exclude?: ReadonlySet<string> | undefined;
  /** Restrict to one region (`model` only exists there, or the user pinned it). */
  region?: WorkBuddyRegion | undefined;
  /**
   * Renew a token that is about to expire.
   *
   * The request path wants this, because a stale token is a failed turn. The
   * settings panel does not: it polls the account view every second or so, and
   * a refresh there would make the panel wait on the network for a verdict it
   * is only describing.
   */
  refreshTokens?: boolean | undefined;
}
interface WorkBuddyRouterOptions {
  store: WorkBuddyDualCredentialStore;
  client: WorkBuddyUpstreamClient;
  health: WorkBuddyHealthStore;
  /** Last known credit balance per `region/uid`; the panel keeps these warm. */
  credits?: ((region: WorkBuddyRegion, uid: string) => number | undefined) | undefined;
  /**
   * Whether this lane's catalog offers the model at all.
   *
   * Crossing lanes is only useful for models both gateways serve — Flash is on
   * both. A CN-only model (Kimi) has no Global equivalent, and sending it there
   * would trade a rate limit for an unknown model error.
   */
  hasModel?: ((region: WorkBuddyRegion, model: string) => boolean) | undefined;
  now?: (() => number) | undefined;
}
type CandidateKey = string;
declare function candidateKey(region: WorkBuddyRegion, uid: string): CandidateKey;
/** The account this session already used, held across turns of one conversation. */
declare class WorkBuddySessionAffinity {
  private readonly chosen;
  private readonly lastUsed;
  get(sessionKey: string | undefined): CandidateKey | undefined;
  remember(sessionKey: string | undefined, region: WorkBuddyRegion, uid: string): void;
  forget(sessionKey: string | undefined): void;
  markUsed(region: WorkBuddyRegion, uid: string): void;
  lastUsedMap(): Map<CandidateKey, number>;
}
/**
 * Ordered candidates for one request: [this session's account, then the rest].
 *
 * Blocked accounts are dropped only from the `available` list; the plan still
 * records them so the caller can say when the account that was blocked is free
 * again instead of reporting a bare "no account".
 */
declare function planRoute(options: WorkBuddyRouterOptions, affinity: WorkBuddySessionAffinity, request: WorkBuddyRouteRequest): Promise<WorkBuddyRouteCandidate[]>;
/** Earliest moment any blocked lane account becomes usable, for the UI/message. */
declare function nextRecoveryMs(options: WorkBuddyRouterOptions, model: string, region?: WorkBuddyRegion | undefined): Promise<number | undefined>;
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
  /**
   * Automatic account routing. Omit it to keep the single selected account per
   * lane, which is what the unit tests that predate routing rely on.
   */
  route?: WorkBuddyRouteOptions | undefined;
}
interface WorkBuddyRouteOptions {
  router: WorkBuddyRouterOptions;
  affinity: WorkBuddySessionAffinity;
  /** Read at request time so a settings toggle applies to the next turn. */
  enabled?: (() => boolean) | undefined;
  /**
   * Lanes that may borrow the other lane's accounts.
   *
   * The CN lane is the product's default entry point and is the one allowed to
   * fall back to Global. The Global lane stays Global-only: someone who picked
   * GPT-6-Astra there must not silently land on a CN-only model.
   */
  crossLaneFrom: WorkBuddyRegion;
}
declare function createWorkBuddyDualShim(options: WorkBuddyDualShimOptions): WorkBuddyDualShim;
//#endregion
//#region src/adapter.d.ts
declare const WORKBUDDY_CN_PROVIDER = "workbuddy-cn";
declare const WORKBUDDY_GLOBAL_PROVIDER = "workbuddy-global";
/**
 * Picker name of the CN route.
 *
 * It is no longer only CN: the route now spends CN accounts first and reaches
 * for Global when every CN account is cooling down, so the old "WorkBuddy CN"
 * label would describe only half of what a request may do.
 */
declare const WORKBUDDY_CN_DISPLAY_NAME = "WorkBuddy（国内优先）";
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
//#region src/credits-cache.d.ts
declare class WorkBuddyCreditsCache {
  private readonly entries;
  private refreshing;
  /** Balance if it was read recently, else whatever was read last. */
  get(region: WorkBuddyRegion, uid: string): number | undefined;
  set(region: WorkBuddyRegion, uid: string, total: number): void;
  isFresh(region: WorkBuddyRegion, uid: string): boolean;
  forget(region: WorkBuddyRegion, uid: string): void;
  /**
   * Refresh balances that are missing or stale.
   *
   * Never awaited by a request: a slow billing endpoint must not add a round
   * trip to someone's chat turn. Failures leave the previous number in place.
   */
  refresh(store: WorkBuddyDualCredentialStore, client: WorkBuddyUpstreamClient): Promise<void>;
  private run;
}
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
//#region src/agenttool.d.ts
type AgentToolErrorKind = 'auth' | 'client' | 'server' | 'timeout' | 'aborted';
/** Why one `agenttool` call failed; `kind` drives the Harness retry policy. */
declare class AgentToolError extends Error {
  readonly kind: AgentToolErrorKind;
  readonly status: number;
  constructor(message: string, kind: AgentToolErrorKind, status?: number);
}
interface AgentToolSearchResult {
  sources: Array<{
    url: string;
    title?: string;
    snippet?: string;
  }>;
  truncated: boolean;
}
interface AgentToolFetchResult {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
}
interface AgentToolClient {
  search(credential: WorkBuddyCredential, query: string, maxResults: number | undefined, signal: AbortSignal | undefined): Promise<AgentToolSearchResult>;
  fetch(credential: WorkBuddyCredential, url: string, signal: AbortSignal | undefined): Promise<AgentToolFetchResult>;
}
declare function createAgentToolClient(): AgentToolClient;
//#endregion
//#region src/native-web.d.ts
declare const WORKBUDDY_NATIVE_SEARCH_SERVICE = "workbuddyNativeSearch";
declare const WORKBUDDY_NATIVE_FETCH_SERVICE = "workbuddyNativeFetch";
interface WorkBuddyNativeSearch {
  available(): boolean;
  search(query: string, options?: {
    region?: WorkBuddyRegion;
    model?: string;
    maxResults?: number;
    signal?: AbortSignal;
  }): Promise<AgentToolSearchResult>;
}
interface WorkBuddyNativeFetch {
  available(): boolean;
  fetch(url: string, options?: {
    region?: WorkBuddyRegion;
    signal?: AbortSignal;
  }): Promise<AgentToolFetchResult>;
}
interface WorkBuddyNativeWebOptions {
  store: WorkBuddyDualCredentialStore;
  client: AgentToolClient;
  /** Region of the model this turn is running, so one credential serves both. */
  resolveRegion?: () => WorkBuddyRegion | undefined;
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
  };
}
declare function createWorkBuddyNativeWeb(options: WorkBuddyNativeWebOptions): {
  search: WorkBuddyNativeSearch;
  fetch: WorkBuddyNativeFetch;
};
/** Publish both services on the plugin context, the way `dsh-grok-oauth` does. */
declare function provideWorkBuddyNativeWeb(ctx: Context, web: {
  search: WorkBuddyNativeSearch;
  fetch: WorkBuddyNativeFetch;
}): void;
//#endregion
//#region src/account-paths.d.ts
declare const WORKBUDDY_DUAL_ACCOUNTS_PATH = "/plugins/dsh-workbuddy-dual/accounts";
/**
 * The model whose availability decides which account is worth using.
 * It is the cheap flash tier, not the flagship: an account with thousands of
 * credits is useless when this one is rate limited.
 */
declare const WORKBUDDY_FLASH_MODEL = "deepseek-v4.1-flash";
/** Whether one account can run the flash model right now. */
interface WorkBuddyWebProbe {
  verdict: WorkBuddyProbeVerdict;
  /** Model the verdict belongs to. */
  model: string;
  /** Epoch ms when a rate limit lifts. */
  resetsAtMs?: number | undefined;
  checkedAt: number;
  detail?: string | undefined;
}
/** One row in the account list. */
interface WorkBuddyWebAccount {
  uid: string;
  /** Masked identifier, e.g. `173****0329`; never the full uid. */
  displayName: string;
  nickname?: string | undefined;
  label?: string | undefined;
  /** True for the account the plugin currently uses. */
  active: boolean;
  /** True for the entry that is not in the pool (desktop sign-in / cache). */
  fallback: boolean;
  expiresAtMs?: number | undefined;
  credits?: number | undefined;
  creditsAt?: number | undefined;
  probe?: WorkBuddyWebProbe | undefined;
}
/** One region's account list plus the state of its fallback credential. */
interface WorkBuddyWebRegionAccounts {
  region: WorkBuddyRegion;
  /** The sign-in the plugin would use when no pool entry is selected. */
  fallbackSignedIn: boolean;
  fallbackName?: string | undefined;
  fallbackSource?: 'desktop' | 'dsh' | 'pool' | undefined;
  /** Credits of the fallback sign-in, when it could be read. */
  fallbackCredits?: number | undefined;
  /** Flash verdict for the fallback sign-in, when it has been checked. */
  fallbackProbe?: WorkBuddyWebProbe | undefined;
  /** True when the plugin ignores the pool and uses the fallback credential. */
  usingFallback: boolean;
  accounts: readonly WorkBuddyWebAccount[];
  /** Model whose availability the rows report. */
  probeModel: string;
  /**
   * True while this lane is still checking balances or probing upstream.
   *
   * The route answers from cache first and refreshes in the background, so the
   * panel paints instantly and fills in verdicts as they arrive instead of
   * holding the whole settings dialog until every account answered.
   */
  refreshing: boolean;
}
interface WorkBuddyWebAccounts {
  cn: WorkBuddyWebRegionAccounts;
  global: WorkBuddyWebRegionAccounts;
  /** Whether the router may switch accounts without being asked. */
  autoRoute: boolean;
  /** The order accounts would be tried in for the flash model, right now. */
  routing: WorkBuddyWebRouting;
}
/** One account in the router's current order. */
interface WorkBuddyWebRouteEntry {
  region: WorkBuddyRegion;
  uid: string;
  displayName: string;
  /** When this account becomes usable again, if it is cooling down. */
  cooldownUntilMs?: number | undefined;
  /** Short reason it is out of rotation. */
  blocked?: string | undefined;
}
interface WorkBuddyWebRouting {
  /** Model the order was computed for. */
  model: string;
  /** Usable accounts, in the order the next request would try them. */
  order: readonly WorkBuddyWebRouteEntry[];
  /** Accounts held back by a cooldown, soonest recovery first. */
  blocked: readonly WorkBuddyWebRouteEntry[];
  /** Epoch ms when the earliest blocked account frees up. */
  nextRecoveryMs?: number | undefined;
}
//#endregion
//#region src/account-route.d.ts
interface WorkBuddyDualAccountRouteOptions {
  store: WorkBuddyDualCredentialStore;
  client: WorkBuddyUpstreamClient;
  /** Rebuild catalogs and notify pickers after the active account changes. */
  onAccountChange?: ((region: WorkBuddyRegion) => void | Promise<void>) | undefined;
  /** The automatic-switching preference and the route it produces. */
  router?: {
    settings: () => boolean;
    setAutoRoute: (enabled: boolean) => Promise<boolean>;
    /**
     * Persist a probe verdict for routing.
     *
     * The panel's probe is a real one-token request, so its answer is exactly
     * what the router needs. Without this the panel could show "limited until
     * 07:28" while the router still handed the next turn to that same account
     * and only learned about the limit by failing.
     */
    record: (region: WorkBuddyRegion, uid: string, model: string, probe: WorkBuddyWebProbe) => Promise<void>;
    /** Accounts in the order the next flash request would try them. */
    order: () => Promise<{
      order: readonly WorkBuddyWebRouteEntry[];
      blocked: readonly WorkBuddyWebRouteEntry[];
      nextRecoveryMs?: number | undefined;
    }>;
  } | undefined;
}
interface CachedCredits {
  total: number;
  at: number;
}
interface CachedProbe {
  probe: WorkBuddyWebProbe;
  at: number;
}
/** Parse one auth document; `parseWorkBuddyAuth` owns the decryption rules. */
declare function readAuthFile(path: string, region: WorkBuddyRegion): Promise<WorkBuddyCredential>;
interface WorkBuddyAccountRouteState {
  credits: Map<string, CachedCredits>;
  probes: Map<string, CachedProbe>;
  /** Called with every fresh probe verdict, so the router sees it too. */
  onProbe?: ((region: WorkBuddyRegion, uid: string, model: string, probe: WorkBuddyWebProbe) => void | Promise<void>) | undefined;
  /** One in-flight background refresh per lane, so polling cannot stack them. */
  refreshing: Map<WorkBuddyRegion, Promise<void>>;
  /** Lanes asked to refresh again as soon as the current pass finishes. */
  queued: Set<WorkBuddyRegion>;
  /** Epoch ms of the last failure per cache key, so a dead token backs off. */
  failures: Map<string, number>;
}
declare function createAccountRouteState(): WorkBuddyAccountRouteState;
declare function workBuddyAccountsView(deps: WorkBuddyDualAccountRouteOptions, state: WorkBuddyAccountRouteState): Promise<WorkBuddyWebAccounts>;
//#endregion
//#region src/index.d.ts
declare const WORKBUDDY_DUAL_SETTINGS_NS = "workbuddy-dual";
interface WorkBuddyDualConfig {
  cnAuthFile?: string;
  globalAuthFile?: string;
  /** Automatic account switching; on by default, off restores manual only. */
  autoRoute?: boolean;
}
declare const Config: z<WorkBuddyDualConfig>;
declare const name = "dsh-workbuddy-dual";
declare const inject: readonly ["llm"];
declare function apply(ctx: Context, config?: WorkBuddyDualConfig): void;
//#endregion
export { AgentToolError, Config, REGION_ORDER, WORKBUDDY_CN_DISPLAY_NAME, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_ACCOUNTS_PATH, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_FLASH_MODEL, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_HEALTH_FILENAME, WORKBUDDY_NATIVE_FETCH_SERVICE, WORKBUDDY_NATIVE_SEARCH_SERVICE, WorkBuddyAccountPool, WorkBuddyCreditsCache, WorkBuddyDualCatalog, WorkBuddyDualConfig, WorkBuddyDualCredentialStore, type WorkBuddyDualSelection, WorkBuddyDualSelectionStore, WorkBuddyHealthStore, type WorkBuddyRouteCandidate, type WorkBuddyRouterOptions, WorkBuddySessionAffinity, WorkBuddyUpstreamClient, advertisedModelIds, apply, candidateKey, cooldownFor, createAccountRouteState, createAgentToolClient, createWorkBuddyDualAdapter, createWorkBuddyDualShim, createWorkBuddyNativeWeb, defaultSelection, filterModels, healthKey, inject, name, nextRecoveryMs, normalizeLanePreference, normalizeSelection, planRoute, poolDocumentPath, provideWorkBuddyNativeWeb, readAuthFile, toCredential, workBuddyAccountsView };