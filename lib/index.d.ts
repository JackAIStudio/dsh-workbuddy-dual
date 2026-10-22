import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
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
  source: 'desktop' | 'dsh';
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
  source: 'desktop' | 'dsh';
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
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  refreshMarginMs?: number | undefined;
}
declare class RegionCredentialStore {
  readonly region: WorkBuddyRegion;
  private desktopPathOverride?;
  private readonly ownPath;
  private readonly refresh;
  private readonly refreshMarginMs;
  private inflight?;
  constructor(options: RegionStoreOptions);
  setDesktopPath(path: string | undefined): void;
  resolveDesktopCandidates(): string[];
  desktopFilePresent(): Promise<boolean>;
  private readDesktop;
  private readOwn;
  private saveOwn;
  logout(): Promise<void>;
  current(): Promise<WorkBuddyCredential | undefined>;
  private needsRefresh;
  resolve(): Promise<WorkBuddyCredential>;
  private refreshNow;
  status(): Promise<WorkBuddyAuthStatus>;
}
declare class WorkBuddyDualCredentialStore {
  readonly cn: RegionCredentialStore;
  readonly global: RegionCredentialStore;
  constructor(options: {
    refreshCN: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
    refreshGlobal: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
    cnPathOverride?: string | undefined;
    globalPathOverride?: string | undefined;
  });
  storeFor(region: WorkBuddyRegion): RegionCredentialStore;
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