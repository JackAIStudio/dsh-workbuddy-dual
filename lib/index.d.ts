import z from "@deepseek-ai/schemastery";
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
//#region src/catalog.d.ts
declare class WorkBuddyDualCatalog {
  private cnModels;
  private globalModels;
  modelsFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[];
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
  private parseModelsList;
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
}
interface WorkBuddyDualAdapter {
  adapter: PiAiAdapter;
  invalidate: () => void;
}
declare function createWorkBuddyDualAdapter(options: WorkBuddyDualAdapterOptions): WorkBuddyDualAdapter;
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
export { Config, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_GLOBAL_PROVIDER, WorkBuddyDualCatalog, WorkBuddyDualConfig, WorkBuddyDualCredentialStore, WorkBuddyUpstreamClient, apply, createWorkBuddyDualAdapter, createWorkBuddyDualShim, inject, name };