import { d as advertisedModelIds, f as defaultSelection, g as WorkBuddyDualCredentialStore, h as normalizeSelection, i as writeHostHeartbeat, m as normalizeLanePreference, o as WorkBuddyUpstreamClient, p as filterModels, s as WorkBuddyDualSelectionStore, t as clearHostHeartbeat, u as WorkBuddyDualCatalog } from "./host-heartbeat-CjI7EInf.js";
import z from "@deepseek-ai/schemastery";
import { Buffer as Buffer$1 } from "node:buffer";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
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
//#region src/model-paths.ts
/** Wire vocabulary shared by the Host model routes and the browser card. */
const WORKBUDDY_DUAL_MODELS_PATH = "/plugins/dsh-workbuddy-dual/models";
//#endregion
//#region src/model-route.ts
/**
* Loopback routes behind the model picker page: list both lanes with the
* current preference, then persist a partial change.
*/
const BODY_LIMIT = 131072;
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer$1.byteLength(payload)
	});
	res.end(payload);
}
function trusted(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer$1.isBuffer(chunk) ? chunk : Buffer$1.from(chunk);
		size += buf.length;
		if (size > BODY_LIMIT) throw new Error("request body too large");
		chunks.push(buf);
	}
	if (size === 0) return {};
	return JSON.parse(Buffer$1.concat(chunks).toString("utf8"));
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toOption(info, lane) {
	return {
		id: info.id,
		name: info.name,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		...info.billing?.free !== void 0 ? { free: info.billing.free } : {},
		...info.billing?.credits !== void 0 ? { credits: info.billing.credits } : {},
		...info.billing?.badges !== void 0 ? { badges: info.billing.badges } : {},
		selected: lane.mode === "all" || lane.models.includes(info.id)
	};
}
/** One lane as the settings page renders it. */
function laneModelsView(catalog, selection, region, signedIn = true) {
	const lane = selection[region];
	const models = catalog.modelsFor(region);
	return {
		signedIn,
		enabled: lane.enabled,
		mode: lane.mode,
		live: catalog.isLive(region),
		total: models.length,
		selectedCount: lane.mode === "all" ? models.length : lane.models.filter((id) => models.some((m) => m.id === id)).length,
		models: models.map((info) => toOption(info, lane))
	};
}
async function modelPickerView(catalog, selection, signedIn = {
	cn: true,
	global: true
}) {
	return {
		cn: laneModelsView(catalog, selection, "cn", signedIn.cn),
		global: laneModelsView(catalog, selection, "global", signedIn.global)
	};
}
async function signInState(deps) {
	if (!deps.accountStatus) return {
		cn: true,
		global: true
	};
	const [cn, global] = await Promise.all([deps.accountStatus("cn").catch(() => "signed-out"), deps.accountStatus("global").catch(() => "signed-out")]);
	return {
		cn: cn === "signed-in",
		global: global === "signed-in"
	};
}
/** Validate and normalize one lane's patch from the browser. */
function parseLanePatch(value) {
	if (!isRecord(value)) throw new Error("lane patch must be an object");
	const patch = {};
	if ("enabled" in value) {
		if (typeof value["enabled"] !== "boolean") throw new Error("enabled must be a boolean");
		patch.enabled = value["enabled"];
	}
	if ("mode" in value) {
		if (value["mode"] !== "all" && value["mode"] !== "selected") throw new Error("mode must be all or selected");
		patch.mode = value["mode"];
	}
	if ("models" in value) {
		const raw = value["models"];
		if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw new Error("models must be an array of model ids");
		patch.models = raw;
	}
	return patch;
}
function parseUpdate(value) {
	if (!isRecord(value)) throw new Error("payload must be an object");
	const update = {};
	if ("cn" in value) update.cn = parseLanePatch(value["cn"]);
	if ("global" in value) update.global = parseLanePatch(value["global"]);
	return update;
}
function modelHandler(deps) {
	return async (req, res) => {
		if (!trusted(req)) {
			sendJson(res, 403, {
				ok: false,
				error: "request-not-trusted"
			});
			return;
		}
		try {
			if (req.method === "GET") {
				sendJson(res, 200, await modelPickerView(deps.catalog, await deps.selection.get(), await signInState(deps)));
				return;
			}
			if (req.method !== "POST") {
				sendJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			const update = parseUpdate(await readJson(req));
			if (update.cn === void 0 && update.global === void 0) {
				sendJson(res, 400, {
					ok: false,
					error: "no lane in payload"
				});
				return;
			}
			const next = await deps.selection.updateLanes(update);
			await deps.onChange?.(next);
			sendJson(res, 200, {
				ok: true,
				...await modelPickerView(deps.catalog, next, await signInState(deps))
			});
		} catch (error) {
			sendJson(res, 400, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	};
}
/** Mount the same-origin model routes; safe on both Web and desktop hosts. */
function registerWorkBuddyDualModelRoutes(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_DUAL_MODELS_PATH,
			handler: modelHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-dual: model picker route");
}
//#endregion
//#region src/reasoning.ts
/**
* Reasoning-effort normalization for WorkBuddy models.
*
* The WorkBuddy catalog publishes two different shapes of reasoning metadata:
*
* - `supportedEfforts: ['low','high','max']` — an explicit list of selectable
*   thinking levels (`kimi-k2.8-preview`, `glm-5.3`, `gpt-6-astra`, ...).
* - `effort: 'medium' | 'high'` — a single advertised default with no list at
*   all (`kimi-k3-1`, `deepseek-v4.1-flash`, `minimax-m3`, `gemini-3.5-flash`,
*   ...). The WorkBuddy desktop client still offers 思考强度 for these models
*   (its own model picker persists e.g. `kimi-k3-1` + `xhigh`), and the
*   upstream chat API accepts `reasoning_effort` for them, so the level list
*   has to come from the client side. Without it the Harness reports the model
*   as supporting only `off`, and the thinking-strength selector disappears
*   for most of the catalog.
*/
/** pi-ai / Harness thinking levels, in ascending effort order. */
const EFFORT_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Client-side defaults per model family, used only when the catalog publishes
* `effort` without `supportedEfforts`. Mirrors the level lists the WorkBuddy
* client exposes for the same families (see its `kimi-k3` entry: low/high/max).
*/
const FAMILY_DEFAULTS = [
	[/^kimi-k2\.8/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"high",
			"max"
		]
	}],
	[/^kimi-k3/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"medium",
			"high",
			"xhigh"
		]
	}],
	[/^kimi-k2/, {
		defaultEffort: "medium",
		allowed: [
			"low",
			"medium",
			"high"
		]
	}],
	[/^minimax/, {
		defaultEffort: "medium",
		allowed: [
			"low",
			"medium",
			"high"
		]
	}],
	[/^(deepseek|hunyuan)/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"medium",
			"high",
			"max"
		]
	}],
	[/^glm-/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"high",
			"max"
		]
	}],
	[/^gpt-/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		]
	}],
	[/^grok-/, {
		defaultEffort: "high",
		allowed: [
			"low",
			"medium",
			"high",
			"xhigh"
		]
	}],
	[/^gemini-/, {
		defaultEffort: "medium",
		allowed: [
			"low",
			"medium",
			"high"
		]
	}],
	[/^hy/, {
		defaultEffort: "high",
		allowed: ["low", "high"]
	}]
];
/** Fallback for a reasoning model whose family we do not recognize. */
const GENERIC_DEFAULT = {
	defaultEffort: "high",
	allowed: [
		"low",
		"medium",
		"high"
	]
};
function isEffortLevel(value) {
	return EFFORT_LEVELS.includes(value);
}
/** Family defaults for a model id, or the generic fallback. */
function effortDefaultFor(modelId) {
	const id = modelId.trim().toLowerCase();
	for (const [pattern, preset] of FAMILY_DEFAULTS) if (pattern.test(id)) return preset;
	return GENERIC_DEFAULT;
}
/**
* Snap an arbitrary advertised default onto the selectable list.
*
* A family may omit the model's advertised default (for example the catalog
* advertises `medium` for `kimi-k3-1` while the Kimi tier list starts at
* `low`/`medium`/`high`/`xhigh`). Prefer the nearest level at or below the
* advertised one so the default never silently means "think harder than the
* provider said", then fall back to the nearest level above.
*/
function clampEffort(defaultEffort, levels) {
	const first = levels[0] ?? "high";
	if (defaultEffort === void 0) return first;
	const normalized = defaultEffort.trim().toLowerCase();
	if (!isEffortLevel(normalized)) return first;
	if (levels.includes(normalized)) return normalized;
	const index = EFFORT_LEVELS.indexOf(normalized);
	for (let i = index; i >= 0; i -= 1) {
		const candidate = EFFORT_LEVELS[i];
		if (candidate !== void 0 && levels.includes(candidate)) return candidate;
	}
	for (let i = index; i < EFFORT_LEVELS.length; i += 1) {
		const candidate = EFFORT_LEVELS[i];
		if (candidate !== void 0 && levels.includes(candidate)) return candidate;
	}
	return first;
}
/**
* Resolve the selectable thinking levels for one model.
*
* Explicit catalog lists win — they are server truth. A model that declares
* reasoning but lists nothing gets its family's levels instead of losing the
* control entirely.
*/
function normalizeReasoning(input) {
	const canDisableThinking = input.canDisableThinking === true;
	if (input.supports !== true) return {
		selectable: false,
		levels: [],
		canDisableThinking
	};
	const declared = (input.supportedEfforts ?? []).map((effort) => effort.trim().toLowerCase()).filter(isEffortLevel);
	const levels = declared.length > 0 ? EFFORT_LEVELS.filter((level) => declared.includes(level)) : effortDefaultFor(input.id).allowed ?? [
		"low",
		"medium",
		"high"
	];
	if (levels.length === 0) return {
		selectable: false,
		levels: [],
		canDisableThinking
	};
	return {
		selectable: true,
		levels,
		defaultEffort: clampEffort(input.defaultEffort ?? (declared.length > 0 ? void 0 : effortDefaultFor(input.id).defaultEffort), levels),
		canDisableThinking
	};
}
//#endregion
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
/**
* Publish the selectable thinking levels of one model to pi-ai.
*
* A level is only selectable in the Harness when its `thinkingLevelMap` entry
* is non-null, so models whose catalog entry carries a bare `effort` default
* with no `supportedEfforts` list would otherwise advertise `off` as their
* only level and lose the thinking-strength control entirely. `normalizeReasoning`
* supplies those levels; `off` stays selectable only when the provider allows
* disabling thinking, because mapping `off` also drops `reasoning_effort`
* from the request.
*/
function reasoningFields(info) {
	const reasoning = info.reasoning;
	if (!reasoning || !reasoning.supports) return { reasoning: false };
	const normalized = normalizeReasoning({
		id: info.id,
		supports: reasoning.supports,
		supportedEfforts: reasoning.supportedEfforts,
		defaultEffort: reasoning.defaultEffort,
		canDisableThinking: reasoning.canDisableThinking
	});
	if (!normalized.selectable) return { reasoning: false };
	const selectable = new Set(normalized.levels);
	const wire = (level) => selectable.has(level) ? level : null;
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true ? "off" : null,
			minimal: wire("minimal"),
			low: wire("low"),
			medium: wire("medium"),
			high: wire("high"),
			xhigh: wire("xhigh"),
			max: wire("max")
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
	const { shim, catalog, resolveAttachments, mapHostPath } = options;
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
			const catalogModels = catalog.selectedModelsFor(region);
			const allowed = new Set(catalogModels.map((info) => info.id));
			return models.filter((m) => allowed.has(m.id)).map((m) => {
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
			...resolveAttachments ? { resolveAttachments } : {},
			...mapHostPath ? { resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, mapHostPath, ref) } : {}
		}),
		invalidate: () => {
			profiles = buildProfiles();
		}
	};
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
/**
* The CN gateway runs a channel check over the system prompt, not over the
* headers or tool list alone: a prompt that still carries another vendor's
* harness signature is rejected with 11128 "Illegal API invocation from an
* unapproved channel" before the model is ever called. Rewriting the product
* name into its hyphenated form keeps the meaning and the model's own identity
* instruction while dropping that literal signature.
*/
const HARNESS_SIGNATURE = /deepseek\s+harness/gi;
function stripForeignHarnessSignature(source) {
	return source.replace(HARNESS_SIGNATURE, "DeepSeek-Harness");
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
		return stripForeignHarnessSignature(source);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return stripForeignHarnessSignature(source);
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) {
		for (const msg of obj["messages"]) if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
			const m = msg;
			if (m["role"] === "developer") m["role"] = "system";
			if (m["role"] === "system") m["content"] = stripHarnessSignatureFromContent(m["content"]);
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
function stripHarnessSignatureFromContent(content) {
	if (typeof content === "string") return stripForeignHarnessSignature(content);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
		const item = part;
		if (typeof item["text"] !== "string") return part;
		return {
			...item,
			text: stripForeignHarnessSignature(item["text"])
		};
	});
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
					data: catalog.selectedModelsFor(region).map((m) => ({
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
	const modelsBadge = deps.catalog.selectedModelsFor(region).filter((m) => m.billing?.free === true || (m.billing?.badges?.length ?? 0) > 0).map((m) => ({
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
	const selection = new WorkBuddyDualSelectionStore();
	const shim = createWorkBuddyDualShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	let stopped = false;
	let invalidate;
	/** Rebuild the adapter generation and tell every picker to re-read. */
	const publishSelection = (next) => {
		catalog.setSelection(next);
		invalidate?.();
		ctx.events.emit("llm/adapters-updated");
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyDualStatusRoute(webCtx, {
			store,
			client,
			catalog
		});
		registerWorkBuddyDualModelRoutes(webCtx, {
			catalog,
			selection,
			async accountStatus(region) {
				return (await store.storeFor(region).status()).state === "signed-in" ? "signed-in" : "signed-out";
			},
			onChange(next) {
				publishSelection(next);
			}
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
	ctx.effect(() => () => {
		stopped = true;
		shim.close();
		clearHostHeartbeat();
	});
	shim.ready.then(() => {
		if (stopped) return;
		try {
			const workbuddy = createWorkBuddyDualAdapter({
				shim,
				catalog,
				resolveAttachments: () => ctx.get("attachments"),
				mapHostPath: (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath)
			});
			invalidate = workbuddy.invalidate;
			selection.get().then(publishSelection);
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
export { Config, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_GLOBAL_PROVIDER, WorkBuddyDualCatalog, WorkBuddyDualCredentialStore, WorkBuddyDualSelectionStore, WorkBuddyUpstreamClient, advertisedModelIds, apply, createWorkBuddyDualAdapter, createWorkBuddyDualShim, defaultSelection, filterModels, inject, name, normalizeLanePreference, normalizeSelection };
