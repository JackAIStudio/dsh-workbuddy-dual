import { i as writeHostHeartbeat, l as WorkBuddyDualCatalog, o as WorkBuddyUpstreamClient, t as clearHostHeartbeat, u as WorkBuddyDualCredentialStore } from "./host-heartbeat-BtsHhrEJ.js";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
//#region src/adapter.ts
/**
* Dual LLM Adapter for WorkBuddy CN and WorkBuddy Global.
*/
const WORKBUDDY_CN_PROVIDER = "workbuddy-cn";
const WORKBUDDY_GLOBAL_PROVIDER = "workbuddy-global";
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-dual: no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
function normalizeCredits(credits) {
	if (!credits) return void 0;
	const trimmed = credits.trim();
	if (!trimmed || /^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((p) => p !== void 0 && p !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name} · ${suffix}`;
}
function reasoningFields(info) {
	const reasoning = info.reasoning;
	if (!reasoning || !reasoning.supports) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	if (!efforts || efforts.length === 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
function toPiModel(info, baseUrl, providerId) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens
	};
}
function createWorkBuddyDualAdapter(options) {
	const { shim, catalog, resolveAttachments } = options;
	const buildModels = (region, providerId) => {
		const baseUrl = shim.baseUrl(region);
		return catalog.modelsFor(region).map((info) => toPiModel(info, baseUrl, providerId));
	};
	const createProviderFor = (region, providerId, displayName) => {
		return {
			...createProvider({
				id: providerId,
				name: displayName,
				auth: { apiKey: {
					name: `${displayName} OAuth Bearer`,
					async resolve() {
						return {
							auth: { apiKey: "dummy-local-bearer" },
							source: displayName
						};
					}
				} },
				models: buildModels(region, providerId),
				api: openAICompletionsApi()
			}),
			getModels: () => buildModels(region, providerId)
		};
	};
	const buildProfiles = () => {
		const cnProvider = createProviderFor("cn", WORKBUDDY_CN_PROVIDER, "WorkBuddy CN");
		const globalProvider = createProviderFor("global", WORKBUDDY_GLOBAL_PROVIDER, "WorkBuddy Global");
		const cnProfile = {
			provider: WORKBUDDY_CN_PROVIDER,
			displayName: "WorkBuddy CN",
			streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-dual CN retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			modelErrors: /* @__PURE__ */ new Map(),
			...REQUEST_IMAGE_BUDGETS,
			piProvider: cnProvider
		};
		const globalProfile = {
			provider: WORKBUDDY_GLOBAL_PROVIDER,
			displayName: "WorkBuddy Global",
			streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-dual Global retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			modelErrors: /* @__PURE__ */ new Map(),
			...REQUEST_IMAGE_BUDGETS,
			piProvider: globalProvider
		};
		return /* @__PURE__ */ new Map([[WORKBUDDY_CN_PROVIDER, cnProfile], [WORKBUDDY_GLOBAL_PROVIDER, globalProfile]]);
	};
	let profiles = buildProfiles();
	class DualPiAiAdapter extends PiAiAdapter {
		async listModels(provider) {
			const models = await super.listModels(provider);
			const region = provider === "workbuddy-global" ? "global" : "cn";
			const catalogModels = catalog.modelsFor(region);
			return models.map((m) => {
				const info = catalogModels.find((x) => x.id === m.id);
				if (!info) return m;
				return {
					...m,
					name: withCatalogDisplay(m.name, info)
				};
			});
		}
		async resolveModel(provider, model, signal) {
			const resolved = await super.resolveModel(provider, model, signal);
			const region = provider === "workbuddy-global" ? "global" : "cn";
			const info = catalog.modelsFor(region).find((x) => x.id === model);
			if (!info) return resolved;
			return {
				...resolved,
				name: withCatalogDisplay(resolved.name, info)
			};
		}
	}
	return {
		adapter: new DualPiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => "dummy-local-bearer",
			...resolveAttachments ? { resolveAttachments } : {}
		}),
		invalidate: () => {
			profiles = buildProfiles();
		}
	};
}
//#endregion
//#region src/loopback.ts
/**
* Loopback host validation for local HTTP surfaces.
*/
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint with dual routing (/cn and /global).
*/
function writeJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json)
	});
	res.end(json);
}
function writeOpenAIError(res, status, code, message) {
	writeJson(res, status, { error: {
		message,
		type: "invalid_request_error",
		code
	} });
}
function isJsonContentType(req) {
	const header = req.headers["content-type"];
	if (!header) return false;
	return header.split(";")[0]?.trim().toLowerCase() === "application/json";
}
async function readBody(req, limit = 16777216) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > limit) throw new Error("Request body exceeds limit");
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) {
		for (const msg of obj["messages"]) if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
			const m = msg;
			if (m["role"] === "developer") m["role"] = "system";
		}
		const firstMsg = obj["messages"][0];
		if (!firstMsg || firstMsg["role"] !== "system") obj["messages"].unshift({
			role: "system",
			content: "You are a helpful assistant."
		});
	}
	if ("tool_choice" in obj) {
		const choice = obj["tool_choice"];
		if (typeof choice === "string") {
			if (choice.trim().toLowerCase() === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
			}
		} else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
			const wrapped = choice;
			const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
			if (type === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
			} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
			else if (type === "function") {
				const fn = wrapped["function"];
				obj["tool_choice"] = (typeof fn?.["name"] === "string" ? fn["name"].trim() : typeof wrapped["name"] === "string" ? wrapped["name"].trim() : "") || "auto";
			}
		}
	}
	return JSON.stringify(obj);
}
function createWorkBuddyDualShim(options) {
	const { store, client, catalog, logger } = options;
	let origin = "http://127.0.0.1:0";
	const server = createServer(async (req, res) => {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			let region = "cn";
			let normalizedPath = url;
			if (url.startsWith("/cn/")) {
				region = "cn";
				normalizedPath = url.slice(3);
			} else if (url.startsWith("/global/")) {
				region = "global";
				normalizedPath = url.slice(7);
			}
			if (req.method === "GET" && (normalizedPath === "/v1/models" || normalizedPath === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.modelsFor(region).map((m) => ({
						id: m.id,
						object: "model",
						created: 0,
						owned_by: `workbuddy-${region}`
					}))
				});
				return;
			}
			if (req.method === "POST" && (normalizedPath === "/v1/chat/completions" || normalizedPath === "/v1/chat/completions/")) {
				await handleChatCompletions(req, res, region);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `Route not found: ${req.method} ${url}`);
		} catch (err) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(err));
			else res.end();
		}
	});
	async function handleChatCompletions(req, res, region) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await store.storeFor(region).resolve();
		} catch (err) {
			writeOpenAIError(res, 401, "not_signed_in", String(err));
			return;
		}
		const prepared = prepareChatBody((await readBody(req)).toString("utf8"));
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, result.status >= 400 && result.status < 600 ? result.status : 502, result.kind, result.message);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		if (!result.response.body) {
			res.end("data: [DONE]\n\n");
			return;
		}
		const reader = result.response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) res.write(value);
			}
		} catch (err) {
			logger?.error(`Streaming failed for ${region}:`, err);
		} finally {
			res.end();
		}
	}
	return {
		get origin() {
			return origin;
		},
		ready: new Promise((resolve, reject) => {
			server.listen(0, "127.0.0.1", () => {
				origin = `http://127.0.0.1:${server.address().port}`;
				resolve();
			});
			server.once("error", reject);
		}),
		baseUrl(region) {
			return `${origin}/${region}/v1`;
		},
		async close() {
			return new Promise((resolve, reject) => {
				server.close((err) => err ? reject(err) : resolve());
			});
		}
	};
}
//#endregion
//#region src/status-paths.ts
const WORKBUDDY_DUAL_STATUS_PATH = "/plugins/dsh-workbuddy-dual/status";
//#endregion
//#region src/web-status.ts
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
async function resolveRegionWebStatus(region, deps) {
	const regionStore = deps.store.storeFor(region);
	const authStatus = await regionStore.status();
	if (authStatus.state !== "signed-in") return {
		status: "signed-out",
		region
	};
	const modelsBadge = deps.catalog.modelsFor(region).filter((m) => m.billing?.free === true || (m.billing?.badges?.length ?? 0) > 0).map((m) => ({
		id: m.id,
		name: m.name,
		...m.billing?.free !== void 0 ? { free: m.billing.free } : {},
		...m.billing?.badges !== void 0 ? { badges: m.billing.badges } : {},
		...m.billing?.credits !== void 0 ? { credits: m.billing.credits } : {}
	}));
	const baseStatus = {
		status: "signed-in",
		region,
		...authStatus.nickname ? { nickname: authStatus.nickname } : {},
		...authStatus.domain ? { domain: authStatus.domain } : {},
		...authStatus.expiresAtMs ? { expiresAt: authStatus.expiresAtMs } : {},
		...modelsBadge.length > 0 ? { models: modelsBadge } : {}
	};
	try {
		const cred = await regionStore.current();
		if (cred) {
			const credits = await deps.client.fetchCredits(cred);
			return {
				...baseStatus,
				credits: {
					total: credits.totalBalance,
					accounts: credits.accounts
				}
			};
		}
	} catch (err) {
		return {
			...baseStatus,
			creditsError: safeMessage(err)
		};
	}
	return baseStatus;
}
async function workBuddyDualWebStatus(deps) {
	const [cn, global] = await Promise.all([resolveRegionWebStatus("cn", deps), resolveRegionWebStatus("global", deps)]);
	return {
		cn,
		global
	};
}
function workBuddyDualStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json(res, 200, await workBuddyDualWebStatus(deps));
		} catch (err) {
			json(res, 500, { error: safeMessage(err) });
		}
	};
}
function registerWorkBuddyDualStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_DUAL_STATUS_PATH,
			handler: workBuddyDualStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-dual: Web status route");
}
//#endregion
//#region src/index.ts
const WORKBUDDY_DUAL_SETTINGS_NS = "workbuddy-dual";
const Config = z.object({
	cnAuthFile: z.string().description("WorkBuddy CN auth file (defaults to workbuddy-desktop.info)"),
	globalAuthFile: z.string().description("WorkBuddy Global auth file (defaults to workbuddy-desktop-ai.info)")
});
const name = "dsh-workbuddy-dual";
const inject = ["llm"];
function apply(ctx, config = {}) {
	const client = new WorkBuddyUpstreamClient();
	const store = new WorkBuddyDualCredentialStore({
		refreshCN: (cred) => client.refreshToken(cred),
		refreshGlobal: (cred) => client.refreshToken(cred),
		cnPathOverride: config.cnAuthFile,
		globalPathOverride: config.globalAuthFile
	});
	const catalog = new WorkBuddyDualCatalog();
	const shim = createWorkBuddyDualShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyDualStatusRoute(webCtx, {
			store,
			client,
			catalog
		});
	});
	let currentConfig = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WORKBUDDY_DUAL_SETTINGS_NS, Config, config, {
			setSource(source) {
				currentConfig = source;
			},
			onChange() {
				const next = currentConfig();
				store.cn.setDesktopPath(next.cnAuthFile);
				store.global.setDesktopPath(next.globalAuthFile);
			}
		});
	});
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		shim.close();
		clearHostHeartbeat();
	});
	shim.ready.then(() => {
		if (stopped) return;
		let invalidate;
		try {
			const workbuddy = createWorkBuddyDualAdapter({
				shim,
				catalog,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidate = workbuddy.invalidate;
			let releaseAdapter;
			let releaseDirectory;
			try {
				releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_CN_PROVIDER, WORKBUDDY_GLOBAL_PROVIDER], workbuddy.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: WORKBUDDY_CN_PROVIDER,
					displayName: "WorkBuddy CN",
					settingsNs: WORKBUDDY_DUAL_SETTINGS_NS,
					settingsPath: ["cnAuthFile"],
					declared: false
				}, {
					provider: WORKBUDDY_GLOBAL_PROVIDER,
					displayName: "WorkBuddy Global",
					settingsNs: WORKBUDDY_DUAL_SETTINGS_NS,
					settingsPath: ["globalAuthFile"],
					declared: false
				}]);
			} finally {
				if (!releaseAdapter || !releaseDirectory) {
					releaseAdapter?.();
					releaseDirectory?.();
				}
			}
			try {
				ctx.effect(() => () => {
					releaseAdapter?.();
					releaseDirectory?.();
				});
			} catch {
				releaseAdapter?.();
				releaseDirectory?.();
				return;
			}
			writeHostHeartbeat();
			(async () => {
				try {
					const cnCred = await store.cn.current();
					if (cnCred) {
						const models = await client.fetchModels(cnCred);
						if (models.length > 0) {
							catalog.setModels("cn", models);
							invalidate?.();
						}
					}
				} catch (err) {
					ctx.logger.warn("dsh-workbuddy-dual: failed to fetch dynamic CN models; fallback active", err);
				}
				try {
					const globalCred = await store.global.current();
					if (globalCred) {
						const models = await client.fetchModels(globalCred);
						if (models.length > 0) {
							catalog.setModels("global", models);
							invalidate?.();
						}
					}
				} catch (err) {
					ctx.logger.warn("dsh-workbuddy-dual: failed to fetch dynamic Global models; fallback active", err);
				}
			})();
		} catch (err) {
			ctx.logger.error("dsh-workbuddy-dual: initialization error", err);
		}
	});
}
//#endregion
export { Config, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_GLOBAL_PROVIDER, WorkBuddyDualCatalog, WorkBuddyDualCredentialStore, WorkBuddyUpstreamClient, apply, createWorkBuddyDualAdapter, createWorkBuddyDualShim, inject, name };
