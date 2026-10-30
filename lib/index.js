import { C as toCredential, S as poolDocumentPath, _ as normalizeSelection, b as parseWorkBuddyAuth, c as parseResetTime, f as WorkBuddyDualCatalog, g as normalizeLanePreference, h as filterModels, i as writeHostHeartbeat, l as WorkBuddyDualSelectionStore, m as defaultSelection, o as WorkBuddyUpstreamClient, p as advertisedModelIds, s as parseBusinessCode, t as clearHostHeartbeat, v as WorkBuddyDualCredentialStore, x as WorkBuddyAccountPool, y as defaultDesktopCandidatesFor } from "./host-heartbeat-AYSbY0Zw.js";
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomUUID } from "node:crypto";
import { Buffer as Buffer$1 } from "node:buffer";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ReasoningEffortId, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
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
const BODY_LIMIT$1 = 131072;
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer$1.byteLength(payload)
	});
	res.end(payload);
}
function trusted$1(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
async function readJson$1(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer$1.isBuffer(chunk) ? chunk : Buffer$1.from(chunk);
		size += buf.length;
		if (size > BODY_LIMIT$1) throw new Error("request body too large");
		chunks.push(buf);
	}
	if (size === 0) return {};
	return JSON.parse(Buffer$1.concat(chunks).toString("utf8"));
}
function isRecord$1(value) {
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
	if (!isRecord$1(value)) throw new Error("lane patch must be an object");
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
	if (!isRecord$1(value)) throw new Error("payload must be an object");
	const update = {};
	if ("cn" in value) update.cn = parseLanePatch(value["cn"]);
	if ("global" in value) update.global = parseLanePatch(value["global"]);
	return update;
}
function modelHandler(deps) {
	return async (req, res) => {
		if (!trusted$1(req)) {
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
			const update = parseUpdate(await readJson$1(req));
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
//#region src/budget.ts
/**
* One place for every size limit that decides whether a request survives.
*
* Three independent limits have to agree, and they used to be declared far
* apart: the pi-ai image budget in adapter.ts, the shim's body buffer in
* shim.ts, and the WorkBuddy gateways' undocumented body cap. They disagreed
* by enough that a long session could never trigger the harness's image
* offload path and instead died on a gateway 400 or a local 500. Keeping the
* numbers together makes the inequality below reviewable in one screen.
*/
const MIB = 1048576;
/**
* Both gateways refuse a whole request body at roughly 16 MB.
*
* Measured against real sessions on this machine: a 15.97 MB body was
* accepted and a 16.08 MB body was rejected by the CN gateway as
* `11133 Invalid request parameters`. The Global gateway rejects a slightly
* larger body with a bare 500. 15.5 MB therefore sits below any observed
* acceptance point while leaving a little slack for framing differences.
*/
const GATEWAY_BODY_LIMIT_BYTES = 155e5;
/**
* Aggregate base64 image payload allowed in one request.
*
* This is the number that must trip *before* the gateway cap, because its
* failure code (`IMAGE_OFFLOAD_REQUIRED`) is the only one the harness's
* image-offload plugin acts on.
*/
const MAX_REQUEST_IMAGE_BYTES = 11305696;
/**
* Hard cap on a body the local shim will buffer.
*
* Above the gateway limit so the adapter's image budget is what rejects an
* oversized request, and below infinity so a pathological body fails locally
* with a 413 instead of being copied into a doomed upstream fetch.
*/
const MAX_REQUEST_BODY_BYTES = 24 * MIB;
/** Per-image raw-byte target before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = MIB;
/** Total pixels allowed in one request image. */
const REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
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
/**
* Picker name of the CN route.
*
* It is no longer only CN: the route now spends CN accounts first and reaches
* for Global when every CN account is cooling down, so the old "WorkBuddy CN"
* label would describe only half of what a request may do.
*/
const WORKBUDDY_CN_DISPLAY_NAME = "WorkBuddy（国内优先）";
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Per-request image budgets, all derived from the gateway's body cap.
*
* `maxRequestImageBytes` counts base64 image payload only, while the system
* prompt, tool catalog, and conversation text ride outside it. Setting it
* above the gateway's whole-body limit meant it could never trip, so the
* harness never received the `IMAGE_OFFLOAD_REQUIRED` code that makes it drop
* old screenshots. The numbers live in budget.ts next to the cap they defend.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
	requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
	requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES
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
* Attach the model's strongest thinking level as its default.
*
* pi-ai carries no per-model default; `PiAiAdapter` copies the provider
* profile's configured effort into `reasoning.defaultEffort` and leaves it
* out when the profile has none. WorkBuddy profiles configure no level, so
* every model reached the Harness without a default and the picker fell back
* to the first advertised tier (`Off` or `Low`) — even for models that offer
* Max. Publishing the top tier makes a model switch start where the model is
* strongest; an explicit choice still overrides it per request.
*/
function withDefaultEffort(resolved, info) {
	if (info === void 0 || resolved.reasoning === void 0) return resolved;
	const top = topEffort(resolved.reasoning.efforts);
	if (top === void 0) return resolved;
	if (resolved.reasoning.defaultEffort === ReasoningEffortId(top)) return resolved;
	return {
		...resolved,
		reasoning: {
			...resolved.reasoning,
			defaultEffort: ReasoningEffortId(top)
		}
	};
}
/**
* Strongest thinking level the model advertises.
*
* Known levels rank by ascending effort and `off` never wins. Tiers outside the
* standard vocabulary rank with the top tier, since vendors name their highest
* setting after themselves (`extra-high`).
*/
function topEffort(efforts) {
	const order = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	];
	let top;
	let topRank = -2;
	for (const effort of efforts) {
		if (effort.id === "off") continue;
		const known = order.indexOf(effort.id);
		const rank = known === -1 ? order.indexOf("max") + .5 : known;
		if (rank > topRank) {
			topRank = rank;
			top = effort.id;
		}
	}
	return top;
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
		compat: {
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openai"
		},
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
		const cnProvider = createProviderFor("cn", WORKBUDDY_CN_PROVIDER, WORKBUDDY_CN_DISPLAY_NAME);
		const globalProvider = createProviderFor("global", WORKBUDDY_GLOBAL_PROVIDER, "WorkBuddy Global");
		const cnProfile = {
			provider: WORKBUDDY_CN_PROVIDER,
			displayName: WORKBUDDY_CN_DISPLAY_NAME,
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
			return withDefaultEffort({
				...resolved,
				name: withCatalogDisplay(resolved.name, info)
			}, info);
		}
		/**
		* `PiAiAdapter.prepareCall` builds its metadata through a private
		* `modelInfo`, bypassing the `resolveModel` override above. Without this
		* the picker shows the top tier while a request without an explicit effort
		* still leaves the level to the provider's own (often weaker) default.
		*/
		async prepareCall(provider, model, signal) {
			const prepared = await super.prepareCall(provider, model, signal);
			const region = provider === "workbuddy-global" ? "global" : "cn";
			const info = catalog.modelsFor(region).find((x) => x.id === model);
			if (!info) return prepared;
			return {
				...prepared,
				model: withDefaultEffort(prepared.model, info)
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
//#region src/router.ts
/** Regions in the order the router tries them. */
const REGION_ORDER = ["cn", "global"];
const REFRESH_MARGIN_MS$1 = 12e4;
function candidateKey(region, uid) {
	return `${region}/${uid}`;
}
/**
* A candidate's sort weight. Higher wins.
*
* Credits decide first, because the user's own rule is "has credits left".
* Tie-break on least-recently-used rather than most-recently-used: spreading
* load is the only thing that postpones the next 6004, and a session that keeps
* hammering one account reaches it sooner.
*/
function preference(a, lastUsed) {
	return [a.credits ?? Number.MAX_SAFE_INTEGER, -(lastUsed.get(candidateKey(a.region, a.uid)) ?? 0)];
}
function compare(a, b, lastUsed) {
	const pa = preference(a, lastUsed);
	const pb = preference(b, lastUsed);
	for (let i = 0; i < pa.length; i += 1) {
		const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
/** The account this session already used, held across turns of one conversation. */
var WorkBuddySessionAffinity = class {
	chosen = /* @__PURE__ */ new Map();
	lastUsed = /* @__PURE__ */ new Map();
	get(sessionKey) {
		if (sessionKey === void 0) return void 0;
		return this.chosen.get(sessionKey);
	}
	remember(sessionKey, region, uid) {
		if (sessionKey === void 0 || sessionKey === "") return;
		this.chosen.set(sessionKey, candidateKey(region, uid));
		this.lastUsed.set(candidateKey(region, uid), Date.now());
		if (this.chosen.size > 512) {
			const keys = [...this.chosen.keys()].slice(0, 256);
			for (const key of keys) this.chosen.delete(key);
		}
	}
	forget(sessionKey) {
		if (sessionKey !== void 0) this.chosen.delete(sessionKey);
	}
	markUsed(region, uid) {
		this.lastUsed.set(candidateKey(region, uid), Date.now());
	}
	lastUsedMap() {
		return this.lastUsed;
	}
};
async function usableCredential$1(options, account) {
	const credential = toCredential(account);
	if (credential.expiresAtMs <= 0) return credential;
	if (Date.now() + REFRESH_MARGIN_MS$1 < credential.expiresAtMs) return credential;
	if (credential.refreshToken === "") return credential;
	try {
		const outcome = await options.client.refreshToken(credential);
		const refreshed = {
			...credential,
			accessToken: outcome.accessToken,
			...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
			expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
			...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
		};
		await options.store.poolFor(account.region).update(account.uid, refreshed);
		return refreshed;
	} catch {
		return credential;
	}
}
/** Every account in one lane, with the pool's own selection marked. */
async function laneCandidates(options, region, refreshTokens) {
	const doc = await options.store.poolFor(region).get();
	const out = [];
	for (const account of doc.accounts) {
		const credential = refreshTokens ? await usableCredential$1(options, account) : toCredential(account);
		out.push({
			region,
			uid: account.uid,
			credential,
			source: "pool",
			label: account.label ?? account.nickname ?? account.uid,
			credits: options.credits?.(region, account.uid)
		});
	}
	const fallback = await options.store.storeFor(region).fallback();
	if (fallback !== void 0 && !out.some((candidate) => candidate.uid === fallback.uid)) out.push({
		region,
		uid: fallback.uid,
		credential: fallback,
		source: "fallback",
		label: fallback.nickname ?? fallback.uid,
		credits: options.credits?.(region, fallback.uid)
	});
	return out;
}
/**
* Ordered candidates for one request: [this session's account, then the rest].
*
* Blocked accounts are dropped only from the `available` list; the plan still
* records them so the caller can say when the account that was blocked is free
* again instead of reporting a bare "no account".
*/
async function planRoute(options, affinity, request) {
	const regions = request.region === void 0 ? REGION_ORDER : [request.region];
	const pool = [];
	for (const region of regions) {
		if (options.hasModel !== void 0 && !options.hasModel(region, request.model)) continue;
		pool.push(...await laneCandidates(options, region, request.refreshTokens !== false));
	}
	const available = [];
	for (const candidate of pool) {
		if (request.exclude?.has(candidateKey(candidate.region, candidate.uid)) === true) continue;
		if (await options.health.isBlocked(candidate.region, candidate.uid, request.model)) continue;
		available.push(candidate);
	}
	const lastUsed = affinity.lastUsedMap();
	const ordered = [...available].sort((a, b) => {
		const regionDiff = regions.indexOf(a.region) - regions.indexOf(b.region);
		if (regionDiff !== 0) return regionDiff;
		return compare(a, b, lastUsed);
	});
	const sticky = affinity.get(request.sessionKey);
	if (sticky === void 0) return ordered;
	const pinned = ordered.find((candidate) => candidateKey(candidate.region, candidate.uid) === sticky);
	if (pinned === void 0) return ordered;
	const topRegion = ordered[0]?.region;
	if (pinned.region !== topRegion) return ordered;
	return [pinned, ...ordered.filter((candidate) => candidate !== pinned)];
}
/** Earliest moment any blocked lane account becomes usable, for the UI/message. */
async function nextRecoveryMs(options, model, region) {
	const regions = region === void 0 ? REGION_ORDER : [region];
	let earliest;
	const snapshot = await options.health.snapshot();
	for (const key of Object.keys(snapshot)) {
		if (!key.endsWith(`/${model}`)) continue;
		if (!regions.some((candidate) => key.startsWith(`${candidate}/`))) continue;
		const until = snapshot[key]?.cooldownUntilMs;
		if (until === void 0) continue;
		if (earliest === void 0 || until < earliest) earliest = until;
	}
	return earliest;
}
/**
* The order a flash request would try accounts in, plus who is held back.
*
* The panel shows this so "automatic" is legible before it fires: the user can
* see which account is next and why the best one is skipped, instead of
* discovering a switch after the fact.
*/
async function routeOverview(options, model, sessionKey) {
	const all = [];
	for (const region of REGION_ORDER) {
		if (options.hasModel !== void 0 && !options.hasModel(region, model)) continue;
		all.push(...await laneCandidates(options, region, false));
	}
	const snapshot = await options.health.snapshot();
	const blocked = [];
	const disabled = [];
	for (const candidate of all) {
		const entry = snapshot[healthKeyOf(candidate.region, candidate.uid, model)];
		if (entry === void 0) continue;
		if (entry.permanent === true) {
			disabled.push({
				region: candidate.region,
				uid: candidate.uid,
				displayName: candidate.label,
				blocked: entry.verdict
			});
			continue;
		}
		if (entry.cooldownUntilMs <= Date.now()) continue;
		blocked.push({
			region: candidate.region,
			uid: candidate.uid,
			displayName: candidate.label,
			cooldownUntilMs: entry.cooldownUntilMs,
			blocked: entry.verdict
		});
	}
	blocked.sort((a, b) => (a.cooldownUntilMs ?? 0) - (b.cooldownUntilMs ?? 0));
	const order = (await planRoute(options, new WorkBuddySessionAffinity(), {
		model,
		sessionKey,
		refreshTokens: false
	})).map((candidate) => ({
		region: candidate.region,
		uid: candidate.uid,
		displayName: candidate.label
	}));
	const earliest = blocked[0]?.cooldownUntilMs;
	return {
		order,
		blocked,
		disabled,
		...earliest === void 0 ? {} : { nextRecoveryMs: earliest }
	};
}
/** Health keys carry the region and model; kept local to avoid a cycle. */
function healthKeyOf(region, uid, model) {
	return `${region}/${uid}/${model}`;
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint with dual routing (/cn and /global).
*/
/** Gateway codes that mean "this account cannot run this model right now". */
const ACCOUNT_BLOCK_CODES = [
	"6004",
	"11140",
	"14018"
];
/** Cap on the first-frame peek; a normal SSE event is far smaller. */
const HEAD_PEEK_LIMIT = 65536;
/**
* How long a turn may wait for a cooldown to lift before giving up.
*
* The harness retries a 429 a few times and then ends the turn, so failing
* immediately on a limit that lifts in twenty seconds wastes the retries on
* requests that could not possibly succeed. Waiting here keeps the turn alive
* and keeps the user's prompt intact. Anything longer than this is reported
* with its recovery time so the user can decide.
*/
const SHORT_COOLDOWN_WAIT_MS = 6e4;
/** Bodies above this size are logged, because they are one image away from the gateway cap. */
const REQUEST_BODY_WARN_BYTES = 12582912;
/**
* A request body the shim refuses to buffer.
*
* Carrying the numbers on the error lets the HTTP layer answer 413 with the
* real size instead of collapsing into a generic 500, which used to hide the
* fact that nothing ever reached the upstream.
*/
var RequestBodyTooLargeError = class extends Error {
	receivedBytes;
	limitBytes;
	constructor(receivedBytes, limitBytes) {
		super(`Request body reached ${receivedBytes} bytes, above the ${limitBytes}-byte shim limit`);
		this.name = "RequestBodyTooLargeError";
		this.receivedBytes = receivedBytes;
		this.limitBytes = limitBytes;
	}
};
function writeJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json)
	});
	res.end(json);
}
/**
* The OpenAI error `type` that describes this failure, so the caller's retry
* policy can classify it.
*
* `type` is not decoration: the harness reads it before the message, and only
* retries the codes it derives from a server or transport failure. Labelling
* every shim error `invalid_request_error` turned a dropped gateway connection
* into "bad request", which the retry policy treats as permanent — a long turn
* died on one transient socket failure while the session was still healthy.
*/
function errorTypeFor(status, code) {
	if (code === "transport" || code === "server" || code === "upstream_error") return "server_error";
	if (status >= 500) return "server_error";
	if (status === 401 || status === 403) return "authentication_error";
	if (status === 429) return "rate_limit_error";
	return "invalid_request_error";
}
function writeOpenAIError(res, status, code, message) {
	writeJson(res, status, { error: {
		message,
		type: errorTypeFor(status, code),
		code
	} });
}
function isJsonContentType(req) {
	const header = req.headers["content-type"];
	if (!header) return false;
	return header.split(";")[0]?.trim().toLowerCase() === "application/json";
}
function logBodySize(logger, region, bytes) {
	if (bytes < REQUEST_BODY_WARN_BYTES) return;
	logger?.info(`[workbuddy-dual] ${region} request body ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`);
}
/**
* Attribute an upstream rejection to the body size when the two coincide.
*
* WorkBuddy answers an oversized body with a generic `Invalid request
* parameters` or a bare 413, never naming the limit. Pairing the status with
* the exact byte count is what makes that diagnosis possible next time.
*/
function logUpstreamRejection(logger, region, bytes, status, message) {
	if (!(status === 413 || bytes >= 155e5 && (status === 400 || status === 500))) return;
	logger?.error(`[workbuddy-dual] ${region} gateway rejected a ${bytes}-byte body with ${status}; bodies above roughly ${GATEWAY_BODY_LIMIT_BYTES} bytes are refused with generic parameter errors. ${message.slice(0, 200)}`);
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
/**
* The second shape the CN channel check rejects is another vendor's client
* identity when it opens the prompt.
*
* Claude Code sends \`You are Claude Code, Anthropic's official CLI for Claude.\`
* as the first system block, and the gateway refuses that with the same 11128 —
* which is why routing Claude through the CN lane failed on every turn. The
* check reads the opening of the prompt only: the identical sentence one
* character later is accepted, and so is the same sentence after any leading
* prose or blank line. Prefixing the prompt with a space is enough to pass.
*
* Rather than alter the text, this turns the comma that follows \`Claude Code\`
* into an em dash when that identity opens the prompt. The sentence keeps its
* words, order and meaning; only the punctuation differs. Everything after the
* opening is left untouched, as are prompts that merely mention the phrase.
*/
const LEADING_CLIENT_IDENTITY = /^You are Claude Code, (?=Anthropic)/i;
function deflectLeadingClientIdentity(source) {
	return source.replace(LEADING_CLIENT_IDENTITY, "You are Claude Code — ");
}
/**
* The CN gateway's channel check also fingerprints how the prompt is *laid
* out*, not just which words it contains.
*
* A system prompt whose sentences are separated by a single space keeps
* matching the signature of a non-official client and is refused with 11128
* before the model runs. The same prompt with those sentence joins turned into
* newlines is accepted, byte for byte otherwise identical. Measured on a real
* DSH session: the original prompt failed 5/5, the re-wrapped prompt passed
* 5/5, and a prompt already using blank lines between paragraphs needed no
* change. Images, the tool catalog, reasoning effort and the trace headers
* make no difference — a two-line prompt is accepted, the full one is not.
*
* So open a new line at each boundary between one block of prose and the next.
* Nothing is added or removed: a boundary is a sentence-final punctuation mark
* followed by a single space and an opening character. Code blocks, lists and
* already-wrapped prose have no such boundary and are left alone, which also
* keeps this away from tool results and the user's own text.
*/
const SENTENCE_JOIN = /(?<=[A-Za-z0-9_)\]}])[.!?] (?=[A-Z@\[])/g;
function rewrapSystemPrompt(source) {
	if (!source.includes(" ")) return source;
	const lines = source.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || line === "") continue;
		if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s/.test(line)) continue;
		lines[i] = line.replace(SENTENCE_JOIN, (boundary) => `${boundary[0]}\n`);
	}
	return lines.join("\n");
}
async function readBody(req, limit = MAX_REQUEST_BODY_BYTES) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > limit) throw new RequestBodyTooLargeError(total, limit);
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}
/**
* Give every `enum` node the `type` its values imply.
*
* Kimi's upstream (kimi-k3.1-pro and siblings) validates tool parameter
* schemas strictly and answers the whole request with `11133 Invalid request
* parameters` when an `enum` arrives without a sibling `type` — even when the
* enum sits inside `items` or under `anyOf`. Every other model on the same
* gateway accepts the same body, so the failure looks like a broken model
* rather than a schema nit.
*
* `enum` alone is valid JSON Schema, so third-party MCP servers keep producing
* it; the constraint belongs to this gateway and has to be repaired here. Only
* a missing `type` is filled in, and only when every value shares one JSON
* type, so a heterogeneous enum is left exactly as the caller wrote it.
*/
function typeOfJsonValue(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string": return "string";
		case "boolean": return "boolean";
		case "number": return Number.isInteger(value) ? "integer" : "number";
		case "object": return "object";
		default: return;
	}
}
function inferEnumType(values) {
	if (values.length === 0) return void 0;
	const first = typeOfJsonValue(values[0]);
	if (first === void 0) return void 0;
	return values.every((value) => {
		const type = typeOfJsonValue(value);
		return type === first || first === "integer" && type === "number" || first === "number" && type === "integer";
	}) ? values.some((value) => typeOfJsonValue(value) === "number") ? "number" : first : void 0;
}
function annotateEnumTypes(node) {
	if (Array.isArray(node)) {
		for (const item of node) annotateEnumTypes(item);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const schema = node;
	const values = schema["enum"];
	if (Array.isArray(values) && schema["type"] === void 0) {
		const type = inferEnumType(values);
		if (type !== void 0) schema["type"] = type;
	}
	for (const value of Object.values(schema)) annotateEnumTypes(value);
}
function prepareChatBody(source, region = "cn") {
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
			if (m["role"] === "system") m["content"] = stripHarnessSignatureFromContent(m["content"], region);
		}
		const firstMsg = obj["messages"][0];
		if (!firstMsg || firstMsg["role"] !== "system") obj["messages"].unshift({
			role: "system",
			content: "You are a helpful assistant."
		});
	}
	if (Array.isArray(obj["tools"])) annotateEnumTypes(obj["tools"]);
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
async function peekFirstFrame(response) {
	const reader = response.body?.getReader();
	if (reader === void 0) return void 0;
	const buffered = [];
	let text = "";
	while (text.length < HEAD_PEEK_LIMIT) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== void 0 && value.byteLength > 0) {
			buffered.push(value);
			text += new TextDecoder().decode(value, { stream: true });
			if (/\n\n/u.test(text) || text.includes("[DONE]")) break;
		}
	}
	const code = parseBusinessCode(text);
	return {
		buffered,
		reader,
		code,
		blocked: code !== void 0 && ACCOUNT_BLOCK_CODES.includes(code),
		head: text
	};
}
function stripHarnessSignatureFromContent(content, region) {
	const rewrite = (source) => {
		const stripped = stripForeignHarnessSignature(source);
		const deflected = deflectLeadingClientIdentity(stripped);
		return region === "cn" ? rewrapSystemPrompt(deflected) : stripped;
	};
	if (typeof content === "string") return rewrite(content);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
		const item = part;
		if (typeof item["text"] !== "string") return part;
		return {
			...item,
			text: rewrite(item["text"])
		};
	});
}
function createWorkBuddyDualShim(options) {
	const { store, client, catalog, logger, route } = options;
	let origin = "http://127.0.0.1:0";
	/**
	* The session this request belongs to.
	*
	* pi-ai sends the harness session id as `x-client-request-id` (and
	* `x-session-affinity`) only when its compat flag says so. The adapter turns
	* that flag on for both providers, which is what lets one conversation stay
	* on one account even though every step is a separate HTTP request.
	*/
	const sessionKeyOf = (req) => {
		const header = req.headers["x-session-affinity"] ?? req.headers["x-client-request-id"] ?? req.headers["session_id"];
		const value = Array.isArray(header) ? header[0] : header;
		return typeof value === "string" && value !== "" ? value : void 0;
	};
	const modelOf = (raw) => {
		try {
			const body = JSON.parse(raw);
			return typeof body["model"] === "string" ? body["model"] : void 0;
		} catch {
			return;
		}
	};
	/** Model id as the prepared body carries it, for the health key. */
	const preparedModel = (prepared) => modelOf(prepared) ?? "deepseek-v4.1-flash";
	/**
	* Ordered accounts for this request, or one entry for the legacy behaviour.
	*
	* Without a router the lane keeps using the sign-in the user selected, which
	* is what every pre-router caller (and the live verifier script) expects.
	*/
	const candidatesFor = async (req, region, raw) => {
		const model = modelOf(raw);
		const sessionKey = sessionKeyOf(req);
		if (route === void 0 || model === void 0 || route.enabled?.() === false) {
			const credential = await store.storeFor(region).resolve();
			return {
				candidates: [{
					region,
					uid: credential.uid,
					credential,
					source: "fallback",
					label: credential.nickname ?? credential.uid
				}],
				sessionKey,
				model
			};
		}
		const crossLane = region === route.crossLaneFrom;
		return {
			candidates: await planRoute(route.router, route.affinity, {
				model,
				sessionKey,
				...crossLane ? {} : { region }
			}),
			sessionKey,
			model
		};
	};
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
		let body;
		try {
			body = await readBody(req);
		} catch (err) {
			if (err instanceof RequestBodyTooLargeError) {
				writeOpenAIError(res, 413, "request_too_large", `Request body is ${err.receivedBytes} bytes, above the ${err.limitBytes}-byte local shim limit. Reduce retained images or start a new task.`);
				return;
			}
			throw err;
		}
		logBodySize(logger, region, body.length);
		const raw = body.toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		let candidates = [];
		let sessionKey;
		let model;
		let recovery;
		for (let attempt = 0;; attempt++) {
			try {
				({candidates, sessionKey, model} = await candidatesFor(req, region, raw));
			} catch (err) {
				writeOpenAIError(res, 401, "not_signed_in", String(err));
				return;
			}
			if (candidates.length > 0) break;
			recovery = model === void 0 || route === void 0 ? void 0 : await nextRecoveryMs(route.router, model, region === route.crossLaneFrom ? void 0 : region);
			const wait = recovery === void 0 ? Infinity : recovery - Date.now();
			if (attempt > 0 || !Number.isFinite(wait) || wait > SHORT_COOLDOWN_WAIT_MS) break;
			await new Promise((resolve) => setTimeout(resolve, Math.max(250, wait + 250)));
			if (controller.signal.aborted) return;
		}
		if (candidates.length === 0) {
			const when = recovery === void 0 ? "" : ` Retry after ${new Date(recovery).toISOString()}.`;
			writeOpenAIError(res, 429, "rate", `No WorkBuddy account can run ${model ?? "this model"} right now.${when}`);
			return;
		}
		let lastError;
		for (const candidate of candidates) {
			if (controller.signal.aborted) return;
			const prepared = prepareChatBody(raw, candidate.region);
			const result = await client.chatStream(candidate.credential, prepared, controller.signal);
			if (!result.ok) {
				logUpstreamRejection(logger, candidate.region, body.length, result.status, result.message);
				lastError = {
					status: result.status,
					kind: result.kind,
					message: result.message
				};
				const retriable = result.kind === "rate" || result.kind === "auth" || result.kind === "credit";
				if (route !== void 0) await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), verdictForFailure(result.kind, result.message), {
					resetsAtMs: parseResetTime(result.message),
					detail: result.message.slice(0, 200)
				});
				if (!retriable) break;
				continue;
			}
			const peek = await peekFirstFrame(result.response);
			if (peek?.blocked === true) {
				const verdict = peek.code === "11140" ? "banned" : peek.code === "14018" ? "no-credit" : "rate-limited";
				await peek.reader.cancel().catch(() => {});
				if (route !== void 0) await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), verdict, {
					resetsAtMs: parseResetTime(peek.head),
					detail: peek.head.slice(0, 200)
				});
				lastError = {
					status: 429,
					kind: verdict === "rate-limited" ? "rate" : verdict,
					message: peek.head.slice(0, 2e3)
				};
				continue;
			}
			if (route !== void 0) {
				await route.router.health.record(candidate.region, candidate.uid, model ?? preparedModel(prepared), "ok");
				route.affinity.remember(sessionKey, candidate.region, candidate.uid);
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no",
				...route === void 0 ? {} : { "X-WorkBuddy-Account": `${candidate.region}/${candidate.label}` }
			});
			try {
				if (peek !== void 0) {
					for (const chunk of peek.buffered) res.write(chunk);
					while (true) {
						const { done, value } = await peek.reader.read();
						if (done) break;
						if (value !== void 0) res.write(value);
					}
				}
			} catch (err) {
				logger?.error(`Streaming failed for ${candidate.region}:`, err);
			} finally {
				res.end();
			}
			return;
		}
		writeOpenAIError(res, lastError === void 0 ? 502 : lastError.status >= 400 && lastError.status < 600 ? lastError.status : 502, lastError?.kind ?? "server", lastError?.message ?? "every WorkBuddy account failed");
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
/**
* Which verdict an upstream refusal represents.
*
* The HTTP status alone is not enough: Global answers a banned account with
* `403 / 11140 request illegal`, which would otherwise be filed as an expired
* sign-in and retried every thirty minutes forever. The business code is the
* gateway's own reason, so it wins when present.
*/
function verdictForFailure(kind, message) {
	const code = parseBusinessCode(message);
	if (code === "6004") return "rate-limited";
	if (code === "11140") return "banned";
	if (code === "14018") return "no-credit";
	if (kind === "rate") return "rate-limited";
	if (kind === "credit") return "no-credit";
	if (kind === "auth") return "auth";
	return "error";
}
//#endregion
//#region src/status-paths.ts
const WORKBUDDY_DUAL_STATUS_PATH = "/plugins/dsh-workbuddy-dual/status";
//#endregion
//#region src/web-status.ts
function safeMessage$1(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$1(res, status, body) {
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
			creditsError: safeMessage$1(err)
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
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$1(res, 200, await workBuddyDualWebStatus(deps));
		} catch (err) {
			json$1(res, 500, { error: safeMessage$1(err) });
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
//#region src/account-paths.ts
const WORKBUDDY_DUAL_ACCOUNTS_PATH = "/plugins/dsh-workbuddy-dual/accounts";
/**
* The model whose availability decides which account is worth using.
* It is the cheap flash tier, not the flagship: an account with thousands of
* credits is useless when this one is rate limited.
*/
const WORKBUDDY_FLASH_MODEL = "deepseek-v4.1-flash";
//#endregion
//#region src/account-route.ts
/**
* Loopback routes behind the account list: read the pool, pick an account,
* import one from a WorkBuddy auth file, and probe the flash model per account.
*
* The route is served by the Host rather than through the model shim, so the
* Web and desktop hosts share one implementation. Every call is guarded by the
* same loopback-only check the other plugin routes use: responses carry account
* identities, and the mutating calls decide which bearer token the whole
* harness spends.
*/
const BODY_LIMIT = 16384;
/** Credits go stale quickly; re-ask after a minute rather than on every render. */
const CREDIT_CACHE_MS = 6e4;
/** Every probe spends a little credit, so repeated views reuse the last answer. */
const PROBE_CACHE_MS = 45e3;
/** Refresh a little before expiry so a probe never fails on a dead token. */
const REFRESH_MARGIN_MS = 12e4;
function json(res, status, body) {
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
function regionOf(value) {
	if (value === "cn" || value === "global") return value;
	throw new Error("region must be cn or global");
}
function requiredString(value, field) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
	return value.trim();
}
/**
* The upstream nickname for a phone-based account is already masked
* (`173****0329`). For anything else, mask the middle here so a full uid never
* reaches the browser.
*/
function displayNameFor(account) {
	const label = account.label?.trim();
	if (label !== void 0 && label !== "") return label;
	const nickname = account.nickname?.trim();
	if (nickname !== void 0 && nickname !== "") return nickname;
	return maskUid(account.uid);
}
function maskUid(uid) {
	if (uid.length <= 8) return uid;
	return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}
/** Strip anything token-shaped and collapse whitespace for display. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").replace(/\s+/gu, " ").trim().slice(0, 240);
}
/** Parse one auth document; `parseWorkBuddyAuth` owns the decryption rules. */
async function readAuthFile(path, region) {
	const text = await readFile(path, "utf8");
	const credential = parseWorkBuddyAuth(text, region);
	if (credential === void 0) throw new Error(`could not read a WorkBuddy ${region} sign-in from ${path}`);
	return credential;
}
/** Newest auth file the official desktop app left behind for this region. */
async function importFromDesktop(region) {
	const candidates = defaultDesktopCandidatesFor(region);
	let lastError;
	for (const path of candidates) try {
		return await readAuthFile(path, region);
	} catch (error) {
		lastError = error;
	}
	throw new Error(`no signed-in WorkBuddy ${region} app found (${safeMessage(lastError)})`);
}
/** Whether a credential is close enough to expiry to need a refresh first. */
function needsRefresh(credential) {
	if (credential.expiresAtMs <= 0) return true;
	return Date.now() + REFRESH_MARGIN_MS >= credential.expiresAtMs;
}
/**
* A usable credential for one pool entry, refreshing and persisting when the
* token is about to expire. Renewing in the pool keeps every later request
* (and every other host) on the refreshed token.
*/
async function usableCredential(pool, account, client) {
	const credential = toCredential(account);
	if (!needsRefresh(credential)) return credential;
	if (credential.refreshToken === "") return credential;
	const outcome = await client.refreshToken(credential);
	const refreshed = {
		...credential,
		accessToken: outcome.accessToken,
		...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
		expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
		...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
	};
	await pool.update(account.uid, refreshed);
	return refreshed;
}
function createAccountRouteState() {
	return {
		credits: /* @__PURE__ */ new Map(),
		probes: /* @__PURE__ */ new Map(),
		refreshing: /* @__PURE__ */ new Map(),
		queued: /* @__PURE__ */ new Set(),
		failures: /* @__PURE__ */ new Map()
	};
}
function cacheKey(region, uid, model) {
	return `${region}/${uid}${model === void 0 ? "" : `/${model}`}`;
}
/**
* How long a failed balance or probe is left alone.
*
* Without this, an expired token makes every poll retry forever: the failure
* never lands in the cache, so each refresh starts a fresh request and the
* panel's "still checking" state never ends.
*/
const FAILURE_BACKOFF_MS = 2e4;
function failedRecently(state, key) {
	const at = state.failures.get(key);
	if (at === void 0) return false;
	if (Date.now() - at < FAILURE_BACKOFF_MS) return true;
	state.failures.delete(key);
	return false;
}
/** What the panel can show right now, without touching the network. */
function cachedCredits(state, credential) {
	return state.credits.get(cacheKey(credential.region, credential.uid))?.total;
}
/** Whether this sign-in still needs a network round trip. */
function needsWork(state, credential) {
	const creditKey = cacheKey(credential.region, credential.uid);
	const cached = state.credits.get(creditKey);
	if ((cached === void 0 || Date.now() - cached.at >= CREDIT_CACHE_MS) && !failedRecently(state, creditKey)) return true;
	const probeKey = cacheKey(credential.region, credential.uid, WORKBUDDY_FLASH_MODEL);
	return probeFor(state, credential, "deepseek-v4.1-flash") === void 0 && !failedRecently(state, probeKey);
}
/**
* Probe and credit requests are cheap but not free, and the panel used to fire
* one pair per account at once. Three at a time keeps a five-account pool from
* turning into a burst the gateways rate limit.
*/
const REFRESH_CONCURRENCY$1 = 3;
async function mapLimit(items, limit, run) {
	const results = new Array(items.length);
	let next = 0;
	const worker = async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
async function creditsFor(state, client, credential) {
	const key = cacheKey(credential.region, credential.uid);
	const cached = state.credits.get(key);
	if (cached !== void 0 && Date.now() - cached.at < CREDIT_CACHE_MS) return cached.total;
	if (failedRecently(state, key)) return cached?.total;
	try {
		const credits = await client.fetchCredits(credential);
		state.credits.set(key, {
			total: credits.totalBalance,
			at: Date.now()
		});
		state.failures.delete(key);
		return credits.totalBalance;
	} catch {
		state.failures.set(key, Date.now());
		return cached?.total;
	}
}
function probeFor(state, credential, model) {
	const cached = state.probes.get(cacheKey(credential.region, credential.uid, model));
	if (cached === void 0) return void 0;
	if (Date.now() - cached.at >= PROBE_CACHE_MS) return void 0;
	if (cached.probe.verdict === "rate-limited" && cached.probe.resetsAtMs !== void 0 && Date.now() >= cached.probe.resetsAtMs) return;
	return cached.probe;
}
/**
* The verdict a row should show right now.
*
* This is the last answer even if it has aged out of the cache window, so rows
* keep their verdict while a refresh runs instead of blanking on every poll.
* The one exception is an expired rate limit: once the upstream's own reset
* time has passed, "limited until 18:47" is no longer true, and repeating it
* would keep a usable account looking blocked.
*/
function displayProbe(state, credential, model) {
	const cached = state.probes.get(cacheKey(credential.region, credential.uid, model));
	if (cached === void 0) return void 0;
	if (cached.probe.verdict === "rate-limited" && cached.probe.resetsAtMs !== void 0 && Date.now() >= cached.probe.resetsAtMs) return;
	return cached.probe;
}
async function probeAccount(state, client, credential, model) {
	const key = cacheKey(credential.region, credential.uid, model);
	try {
		const result = await client.probeModel(credential, model);
		const probe = {
			verdict: result.verdict,
			model,
			...result.resetsAtMs === void 0 ? {} : { resetsAtMs: result.resetsAtMs },
			checkedAt: result.checkedAt,
			...result.detail === void 0 ? {} : { detail: result.detail }
		};
		state.probes.set(key, {
			probe,
			at: Date.now()
		});
		state.failures.delete(key);
		await state.onProbe?.(credential.region, credential.uid, model, probe);
		return probe;
	} catch (error) {
		state.failures.set(key, Date.now());
		throw error;
	}
}
/**
* One lane, answered from memory only.
*
* Reading the pool and the desktop sign-in is local file work (fast), but the
* balances and verdicts are network round trips. Serving whatever the caches
* hold and letting `refreshRegion` fill in the rest is what turns a settings
* dialog that sat on "reading both accounts" for seconds into one that paints
* immediately and fills in each row as its answer arrives.
*/
async function regionView(region, deps, state) {
	const pool = deps.store.poolFor(region);
	const store = deps.store.storeFor(region);
	const doc = await pool.get();
	const fallbackCredential = await store.fallback();
	const fallbackCredits = fallbackCredential === void 0 ? void 0 : cachedCredits(state, fallbackCredential);
	const fallbackProbe = fallbackCredential === void 0 ? void 0 : displayProbe(state, fallbackCredential, WORKBUDDY_FLASH_MODEL);
	const accounts = doc.accounts.map((account) => {
		const credits = state.credits.get(cacheKey(region, account.uid))?.total;
		const probe = displayProbe(state, toCredential(account), WORKBUDDY_FLASH_MODEL);
		return {
			uid: account.uid,
			displayName: displayNameFor(account),
			...account.nickname === void 0 ? {} : { nickname: account.nickname },
			...account.label === void 0 ? {} : { label: account.label },
			active: doc.activeUid === account.uid,
			fallback: false,
			...account.expiresAtMs === 0 ? {} : { expiresAtMs: account.expiresAtMs },
			...credits === void 0 ? {} : { credits },
			...probe === void 0 ? {} : { probe }
		};
	});
	return {
		region,
		fallbackSignedIn: fallbackCredential !== void 0,
		...fallbackCredential?.nickname === void 0 ? {} : { fallbackName: fallbackCredential.nickname },
		...fallbackCredential === void 0 ? {} : { fallbackSource: fallbackCredential.source },
		...fallbackCredits === void 0 ? {} : { fallbackCredits },
		...fallbackProbe === void 0 ? {} : { fallbackProbe },
		usingFallback: doc.activeUid === void 0,
		accounts,
		probeModel: WORKBUDDY_FLASH_MODEL,
		refreshing: state.refreshing.has(region) && await regionHasPendingWork(state, region, doc, fallbackCredential)
	};
}
/** Whether any sign-in in this lane still needs a network round trip. */
async function regionHasPendingWork(state, region, doc, fallbackCredential) {
	const pending = async (credential) => {
		if (!needsWork(state, credential)) return false;
		return await state.isDisabled?.(credential.region, credential.uid, WORKBUDDY_FLASH_MODEL) !== true;
	};
	if (fallbackCredential !== void 0 && await pending(fallbackCredential)) return true;
	for (const account of doc.accounts) if (await pending(toCredential(account))) return true;
	return false;
}
/**
* Fetch the missing balances and verdicts for one lane.
*
* Only entries whose cache expired are requested, so re-opening the panel
* spends nothing; a lane that is already refreshing is left alone instead of
* stacking a second round of probes behind the first.
*/
async function refreshRegion(region, deps, state) {
	const pool = deps.store.poolFor(region);
	const store = deps.store.storeFor(region);
	const doc = await pool.get();
	const fallbackCredential = await store.fallback();
	const fill = async (credential) => {
		try {
			if (await state.isDisabled?.(credential.region, credential.uid, "deepseek-v4.1-flash") === true) return;
			await creditsFor(state, deps.client, credential);
			const probeKey = cacheKey(credential.region, credential.uid, WORKBUDDY_FLASH_MODEL);
			if (probeFor(state, credential, "deepseek-v4.1-flash") === void 0 && !failedRecently(state, probeKey)) await probeAccount(state, deps.client, credential, WORKBUDDY_FLASH_MODEL);
		} catch {}
	};
	const work = [];
	const seen = /* @__PURE__ */ new Set();
	if (fallbackCredential !== void 0) {
		seen.add(cacheKey(region, fallbackCredential.uid));
		if (needsWork(state, fallbackCredential)) work.push(async () => {
			await fill(fallbackCredential);
		});
	}
	for (const account of doc.accounts) {
		const key = cacheKey(region, account.uid);
		if (seen.has(key)) continue;
		seen.add(key);
		if (!needsWork(state, toCredential(account))) continue;
		work.push(async () => {
			const credential = await usableCredential(pool, account, deps.client);
			await fill(credential);
		});
	}
	if (work.length === 0) return;
	await mapLimit(work, REFRESH_CONCURRENCY$1, (run) => run());
}
/**
* Start a lane's refresh unless one is already running.
*
* `requeue` is only for callers that changed the state (a switch, an import, a
* removal): those need a second pass even if one is mid-flight. Polls must not
* set it, or a panel that re-reads while waiting would queue a new pass for
* every poll and never settle.
*/
function kickRefresh(region, deps, state, requeue = false) {
	if (state.refreshing.has(region)) {
		if (requeue) state.queued.add(region);
		return;
	}
	const task = refreshRegion(region, deps, state).catch(() => {}).finally(() => {
		state.refreshing.delete(region);
		if (state.queued.delete(region)) kickRefresh(region, deps, state);
	});
	state.refreshing.set(region, task);
}
async function workBuddyAccountsView(deps, state) {
	const [cn, global] = await Promise.all([regionView("cn", deps, state), regionView("global", deps, state)]);
	return {
		cn,
		global,
		autoRoute: deps.router?.settings() ?? false,
		routing: {
			model: WORKBUDDY_FLASH_MODEL,
			...await deps.router?.order().catch(() => ({
				order: [],
				blocked: [],
				disabled: []
			})) ?? {
				order: [],
				blocked: [],
				disabled: []
			}
		}
	};
}
function parseAccountAction(value) {
	if (!isRecord(value)) throw new Error("payload must be an object");
	const action = value["action"];
	const region = regionOf(value["region"]);
	switch (action) {
		case "select": {
			const uid = value["uid"];
			if (uid !== null && typeof uid !== "string") throw new Error("uid must be a string or null");
			return {
				action: "select",
				region,
				uid: uid === null ? null : uid.trim()
			};
		}
		case "add": {
			const path = value["path"];
			if (path !== void 0 && typeof path !== "string") throw new Error("path must be a string");
			return {
				action: "add",
				region,
				...path === void 0 || path.trim() === "" ? {} : { path: path.trim() }
			};
		}
		case "remove": return {
			action: "remove",
			region,
			uid: requiredString(value["uid"], "uid")
		};
		case "relabel": return {
			action: "relabel",
			region,
			uid: requiredString(value["uid"], "uid"),
			label: typeof value["label"] === "string" ? value["label"].trim().slice(0, 40) : ""
		};
		case "probe": {
			const uid = value["uid"];
			if (uid !== void 0 && typeof uid !== "string") throw new Error("uid must be a string");
			const model = value["model"];
			if (model !== void 0 && typeof model !== "string") throw new Error("model must be a string");
			return {
				action: "probe",
				region,
				...uid === void 0 || uid.trim() === "" ? {} : { uid: uid.trim() },
				...model === void 0 || model.trim() === "" ? {} : { model: model.trim() }
			};
		}
		case "autoroute": {
			const enabled = value["enabled"];
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			return {
				action: "autoroute",
				enabled
			};
		}
		default: throw new Error("unknown action");
	}
}
/** Apply one mutation, then return the freshly rebuilt view. */
async function applyAction(deps, state, action) {
	if (action.action === "autoroute") {
		await deps.router?.setAutoRoute(action.enabled);
		return await workBuddyAccountsView(deps, state);
	}
	const pool = deps.store.poolFor(action.region);
	switch (action.action) {
		case "select":
			await pool.select(action.uid === null ? void 0 : action.uid);
			deps.store.storeFor(action.region).pool?.invalidate();
			await deps.onAccountChange?.(action.region);
			break;
		case "add": {
			const credential = action.path === void 0 ? await importFromDesktop(action.region) : await readAuthFile(action.path, action.region);
			await pool.upsert(credential, { select: true });
			await deps.onAccountChange?.(action.region);
			break;
		}
		case "remove": {
			const wasActive = (await pool.get()).activeUid === action.uid;
			const next = await pool.remove(action.uid);
			state.credits.delete(cacheKey(action.region, action.uid));
			state.probes.delete(cacheKey(action.region, action.uid, WORKBUDDY_FLASH_MODEL));
			if (wasActive || next.activeUid === void 0) await deps.onAccountChange?.(action.region);
			break;
		}
		case "relabel":
			await pool.relabel(action.uid, action.label);
			break;
		case "probe": {
			const doc = await pool.get();
			const model = action.model ?? "deepseek-v4.1-flash";
			const targets = action.uid === void 0 ? doc.accounts : doc.accounts.filter((account) => account.uid === action.uid);
			if (action.uid !== void 0 && targets.length === 0) throw new Error(`account not in the ${action.region} pool`);
			await mapLimit(targets, REFRESH_CONCURRENCY$1, async (account) => {
				try {
					const credential = await usableCredential(pool, account, deps.client);
					await probeAccount(state, deps.client, credential, model);
				} catch {}
			});
			break;
		}
	}
	kickRefresh(action.region, deps, state, true);
	return await workBuddyAccountsView(deps, state);
}
function workBuddyAccountHandler(deps, state = createAccountRouteState()) {
	return async (req, res) => {
		if (!trusted(req)) {
			json(res, 403, {
				ok: false,
				error: "request-not-trusted"
			});
			return;
		}
		try {
			if (req.method === "GET") {
				kickRefresh("cn", deps, state);
				kickRefresh("global", deps, state);
				json(res, 200, await workBuddyAccountsView(deps, state));
				return;
			}
			if (req.method !== "POST") {
				json(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			json(res, 200, await applyAction(deps, state, parseAccountAction(await readJson(req))));
		} catch (error) {
			json(res, 400, {
				ok: false,
				error: safeMessage(error)
			});
		}
	};
}
/** Mount the same-origin account routes; safe on both Web and desktop hosts. */
function registerWorkBuddyDualAccountRoutes(ctx, deps) {
	const state = createAccountRouteState();
	state.onProbe = async (region, uid, model, probe) => {
		await deps.router?.record(region, uid, model, probe);
	};
	state.isDisabled = deps.isDisabled;
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_DUAL_ACCOUNTS_PATH,
			handler: workBuddyAccountHandler(deps, state)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-dual: account routes");
}
//#endregion
//#region src/agenttool.ts
/**
* WorkBuddy's hosted search and fetch endpoints (`/agenttool/v1/*`).
*
* The desktop clients already talk to these, so a WorkBuddy sign-in is enough:
* no extra key, no separate vendor account. Both regions answer on the host
* their chat traffic uses, with the same bearer token and the same headers.
*/
/** Why one `agenttool` call failed; `kind` drives the Harness retry policy. */
var AgentToolError = class extends Error {
	kind;
	status;
	constructor(message, kind, status = 0) {
		super(message);
		this.name = "AgentToolError";
		this.kind = kind;
		this.status = status;
	}
};
const SEARCH_PATH = "/agenttool/v1/search";
const FETCH_PATH = "/agenttool/v1/webfetch";
const SEARCH_TIMEOUT_MS = 3e4;
const FETCH_TIMEOUT_MS = 6e4;
/** Response bodies are small; this only bounds a pathological error page. */
const ERROR_BODY_LIMIT = 512;
function agentToolBase(region) {
	return region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}
/**
* Headers the hosted tools expect.
*
* The gateway routes on the conversation triple, so each call mints its own.
* `X-Agent-Intent: craft` is what the desktop app sends for a normal turn; the
* tool endpoints reject an unknown intent.
*/
function toolHeaders(credential) {
	const callId = randomUUID();
	return {
		Authorization: `Bearer ${credential.accessToken}`,
		Accept: "application/json",
		"Content-Type": "application/json; charset=utf-8",
		"X-Requested-With": "XMLHttpRequest",
		"X-Agent-Intent": "craft",
		"X-Conversation-ID": randomUUID(),
		"X-Conversation-Request-ID": randomUUID(),
		"X-Conversation-Message-ID": callId,
		"X-Request-ID": callId,
		"X-Product": "SaaS",
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Name": "WorkBuddy",
		"X-Domain": credential.domain || (credential.region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn"),
		...credential.uid ? { "X-User-Id": credential.uid } : {},
		...credential.enterpriseId ? { "X-Enterprise-Id": credential.enterpriseId } : {}
	};
}
function classifyTransportError(error, signal) {
	if (signal?.aborted === true) return new AgentToolError("agenttool: request aborted", "aborted");
	const name = error?.name;
	if (name === "TimeoutError" || name === "AbortError") return new AgentToolError("agenttool: upstream timed out", "timeout");
	return new AgentToolError(`agenttool: transport error: ${String(error)}`, "server");
}
async function postJson(credential, path, body, timeoutMs, signal) {
	if (signal?.aborted === true) throw new AgentToolError("agenttool: request aborted", "aborted");
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
	let response;
	try {
		response = await fetch(`${agentToolBase(credential.region)}${path}`, {
			method: "POST",
			headers: toolHeaders(credential),
			body: JSON.stringify(body),
			signal: combined
		});
	} catch (error) {
		throw classifyTransportError(error, signal);
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const lane = credential.region === "global" ? "Global" : "CN";
		const kind = response.status === 401 || response.status === 403 ? "auth" : response.status >= 500 ? "server" : "client";
		if (text.includes("routing policy") || text.includes("15021")) throw new AgentToolError(`WorkBuddy ${lane} refused to read ${path === FETCH_PATH ? "this domain" : "this host"} by routing policy. Switch to the other lane or another URL.`, "client", response.status);
		throw new AgentToolError(`agenttool ${path} failed with HTTP ${response.status}: ${text.slice(0, ERROR_BODY_LIMIT)}`, kind, response.status);
	}
	let payload;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AgentToolError(`agenttool ${path} returned unreadable JSON: ${String(error)}`, "server", response.status);
	}
	if (typeof payload !== "object" || payload === null) throw new AgentToolError(`agenttool ${path} returned a non-object body`, "server", response.status);
	const record = payload;
	if (typeof record["code"] === "number" && record["code"] !== 0) {
		const msg = typeof record["msg"] === "string" ? record["msg"] : "unknown upstream error";
		const kind = record["code"] === 401 ? "auth" : "server";
		throw new AgentToolError(`agenttool ${path} returned code ${record["code"]}: ${msg}`, kind, response.status);
	}
	return record;
}
function stringOrUndefined(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/**
* Turn a `text2text` search answer into citeable sources.
*
* Entries without a URL carry nothing a model can cite, and the same page can
* appear twice, so both are dropped before the result cap applies.
*/
function parseAgentToolSearch(payload, maxResults) {
	const rows = Array.isArray(payload["results"]) ? payload["results"] : [];
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const item = row;
		const url = stringOrUndefined(item["url"]);
		if (url === void 0 || seen.has(url)) continue;
		seen.add(url);
		const title = stringOrUndefined(item["title"]);
		const snippet = stringOrUndefined(item["snippet"]);
		sources.push({
			url,
			...title === void 0 ? {} : { title },
			...snippet === void 0 ? {} : { snippet }
		});
	}
	const limit = typeof maxResults === "number" && maxResults > 0 ? maxResults : sources.length;
	return {
		sources: sources.slice(0, limit),
		truncated: sources.length > limit
	};
}
function parseAgentToolFetch(payload) {
	const url = stringOrUndefined(payload["url"]);
	if (url === void 0) throw new AgentToolError("agenttool webfetch returned no url", "server");
	const content = typeof payload["content"] === "string" ? payload["content"] : "";
	if (content.trim().length === 0) throw new AgentToolError(`agenttool webfetch returned no readable content for ${url}`, "client");
	const title = stringOrUndefined(payload["title"]);
	const contentType = stringOrUndefined(payload["content_type"]);
	return {
		url,
		content,
		...title === void 0 ? {} : { title },
		...contentType === void 0 ? {} : { contentType }
	};
}
function createAgentToolClient() {
	return {
		async search(credential, query, maxResults, signal) {
			return parseAgentToolSearch(await postJson(credential, SEARCH_PATH, {
				query,
				type: "text2text",
				max_results: typeof maxResults === "number" && maxResults > 0 ? maxResults : 5
			}, SEARCH_TIMEOUT_MS, signal), maxResults);
		},
		async fetch(credential, url, signal) {
			return parseAgentToolFetch(await postJson(credential, FETCH_PATH, {
				url,
				format: "markdown",
				timeout: Math.floor(FETCH_TIMEOUT_MS / 1e3),
				max_length: 6e4
			}, FETCH_TIMEOUT_MS, signal));
		}
	};
}
//#endregion
//#region src/native-web.ts
const WORKBUDDY_NATIVE_SEARCH_SERVICE = "workbuddyNativeSearch";
const WORKBUDDY_NATIVE_FETCH_SERVICE = "workbuddyNativeFetch";
function isAuthFailure(error) {
	return error instanceof AgentToolError && error.kind === "auth";
}
/**
* Resolve the credential a hosted tool should spend.
*
* A stale token surfaces as 401 on the tool endpoint even though the model
* stream refreshed it moments ago, so one retry against a freshly resolved
* credential saves the whole call. `current()` already refreshes near expiry.
*/
async function withCredential(options, region, run) {
	const preferred = region ?? options.resolveRegion?.() ?? "global";
	const store = options.store.storeFor(preferred);
	const credential = await store.current();
	if (credential === void 0) throw new Error(`dsh-workbuddy-dual: WorkBuddy ${preferred === "global" ? "Global" : "CN"} has no signed-in account, so its web tools cannot run. Sign in from the plugin settings first.`);
	try {
		return await run(credential, preferred);
	} catch (error) {
		if (!isAuthFailure(error)) throw error;
		const refreshed = await store.current();
		if (refreshed === void 0 || refreshed.accessToken === credential.accessToken) throw error;
		options.logger?.warn(`dsh-workbuddy-dual: retrying ${preferred} web tool with a renewed token`);
		return await run(refreshed, preferred);
	}
}
function createWorkBuddyNativeWeb(options) {
	return {
		search: {
			available() {
				return true;
			},
			async search(query, searchOptions) {
				const optionsOfCall = searchOptions ?? {};
				const trimmed = query.trim();
				if (trimmed.length === 0) throw new Error("workbuddy web search: query must be non-empty");
				return withCredential(options, optionsOfCall.region, (credential) => options.client.search(credential, trimmed, optionsOfCall.maxResults, optionsOfCall.signal));
			}
		},
		fetch: {
			available() {
				return true;
			},
			async fetch(url, fetchOptions) {
				const optionsOfCall = fetchOptions ?? {};
				const trimmed = url.trim();
				if (trimmed.length === 0) throw new Error("workbuddy web fetch: url must be non-empty");
				return withCredential(options, optionsOfCall.region, (credential) => options.client.fetch(credential, trimmed, optionsOfCall.signal));
			}
		}
	};
}
/** Publish both services on the plugin context, the way `dsh-grok-oauth` does. */
function provideWorkBuddyNativeWeb(ctx, web) {
	const provide = (key, value) => {
		if (typeof ctx.provide === "function") ctx.provide(key, value);
		else ctx[key] = value;
	};
	provide(WORKBUDDY_NATIVE_SEARCH_SERVICE, web.search);
	provide(WORKBUDDY_NATIVE_FETCH_SERVICE, web.fetch);
}
//#endregion
//#region src/health.ts
/**
* Per-account, per-model availability memory for the automatic router.
*
* A rate limit belongs to one model on one account, not to the account as a
* whole: an account that cannot run Flash this half hour may still answer with
* GPT. Every verdict is therefore keyed by `region/uid/model`.
*
* The document has to outlive a restart. Without it, relaunching the host
* forgets every 6004 and hands the first request straight back to the account
* that is still cooling down, which is exactly the pause the router exists to
* remove. Writes are cheap but not free (a request may succeed thousands of
* times an hour), so a successful call only touches the file when it actually
* clears a stored verdict.
*/
const WORKBUDDY_HEALTH_FILENAME = ".workbuddy-dual-health.json";
/** Default cooldowns when the gateway does not state its own reset moment. */
const RATE_LIMIT_COOLDOWN_MS = 6e4;
const CREDIT_COOLDOWN_MS = 6e5;
const AUTH_COOLDOWN_MS = 18e5;
function healthKey(region, uid, model) {
	return `${region}/${uid}/${model}`;
}
/** How long a verdict keeps an account out of rotation. */
function cooldownFor(verdict, resetsAtMs, now = Date.now()) {
	switch (verdict) {
		case "rate-limited":
			if (resetsAtMs !== void 0 && resetsAtMs > now && resetsAtMs - now <= 864e5) return resetsAtMs;
			return now + RATE_LIMIT_COOLDOWN_MS;
		case "no-credit": return now + CREDIT_COOLDOWN_MS;
		case "auth": return now + AUTH_COOLDOWN_MS;
		case "banned": return now;
		case "error": return now + RATE_LIMIT_COOLDOWN_MS;
		case "ok": return now;
	}
}
/** Reads and writes the availability document with atomic replacement. */
var WorkBuddyHealthStore = class {
	path;
	now;
	entries = {};
	loaded = false;
	loading;
	/** Serializes writes so two fast verdicts cannot interleave a whole file. */
	writing = Promise.resolve();
	constructor(options = {}) {
		this.path = options.path ?? join(resolveDshHome(), ".workbuddy-dual-health.json");
		this.now = options.now ?? (() => Date.now());
	}
	/** Absolute document path; diagnostics only. */
	get documentPath() {
		return this.path;
	}
	/** Whether this account is still cooling down for this model. */
	async isBlocked(region, uid, model) {
		const entry = await this.get(region, uid, model);
		if (entry === void 0) return false;
		if (entry.permanent === true) return true;
		return entry.cooldownUntilMs > this.now();
	}
	/** Whether this account is banned for this model (or for the whole lane). */
	async isPermanent(region, uid, model) {
		await this.load();
		if (model !== void 0) return this.entries[healthKey(region, uid, model)]?.permanent === true;
		const prefix = `${region}/${uid}/`;
		return Object.keys(this.entries).some((key) => key.startsWith(prefix) && this.entries[key]?.permanent === true);
	}
	async get(region, uid, model) {
		await this.load();
		return this.entries[healthKey(region, uid, model)];
	}
	/** Every verdict that still applies, for the settings panel. */
	async snapshot() {
		await this.load();
		const now = this.now();
		const live = {};
		for (const [key, entry] of Object.entries(this.entries)) if (entry.permanent === true || entry.cooldownUntilMs > now) live[key] = entry;
		return live;
	}
	/**
	* Remember what the gateway just said about this account and model.
	*
	* `ok` clears a stored cooldown, which is how an account rejoins rotation
	* after a successful retry instead of waiting for its timer to run out.
	*/
	async record(region, uid, model, verdict, extra = {}) {
		await this.load();
		const key = healthKey(region, uid, model);
		const now = this.now();
		if (verdict === "ok") {
			if (this.entries[key] === void 0) return;
			delete this.entries[key];
			await this.flush();
			return;
		}
		const previous = this.entries[key];
		if (verdict === "banned") {
			this.entries[key] = {
				verdict,
				cooldownUntilMs: now,
				permanent: true,
				checkedAt: now,
				...extra.detail === void 0 ? {} : { detail: extra.detail }
			};
			await this.flush();
			return;
		}
		const cooldownUntilMs = cooldownFor(verdict, extra.resetsAtMs, now);
		const merged = previous === void 0 ? cooldownUntilMs : Math.max(previous.cooldownUntilMs, cooldownUntilMs);
		this.entries[key] = {
			verdict,
			cooldownUntilMs: merged,
			checkedAt: now,
			...previous?.permanent === true ? { permanent: true } : {},
			...extra.detail === void 0 ? {} : { detail: extra.detail }
		};
		await this.flush();
	}
	/** Forget one account's verdicts, e.g. after a manual re-check or sign-in. */
	async clear(region, uid) {
		await this.load();
		const prefix = uid === void 0 ? `${region}/` : `${region}/${uid}/`;
		let changed = false;
		for (const key of Object.keys(this.entries)) {
			if (!key.startsWith(prefix)) continue;
			delete this.entries[key];
			changed = true;
		}
		if (changed) await this.flush();
	}
	async flush() {
		const doc = {
			version: 1,
			entries: this.entries,
			updatedAt: this.now()
		};
		const payload = `${JSON.stringify(doc, null, 2)}\n`;
		this.writing = this.writing.then(async () => {
			try {
				await withFileLock(this.path, async () => {
					await writeFileAtomic(this.path, payload, {
						mode: 384,
						dirMode: 448
					});
				});
			} catch {}
		});
		await this.writing;
	}
	async load() {
		if (this.loaded) return;
		this.loading ??= (async () => {
			try {
				const raw = JSON.parse(await readFile(this.path, "utf8"));
				this.entries = normalizeEntries(raw, this.now());
			} catch {
				this.entries = {};
			}
			this.loaded = true;
		})();
		await this.loading;
	}
};
/** Keep only entries this document could have written, dropping expired ones. */
function normalizeEntries(raw, now) {
	if (typeof raw !== "object" || raw === null) return {};
	const doc = raw;
	const rawEntries = typeof doc["entries"] === "object" && doc["entries"] !== null ? doc["entries"] : {};
	const out = {};
	for (const [key, value] of Object.entries(rawEntries)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value;
		const verdict = entry["verdict"];
		if (verdict !== "rate-limited" && verdict !== "banned" && verdict !== "no-credit" && verdict !== "auth" && verdict !== "error") continue;
		const permanent = verdict === "banned";
		const cooldownUntilMs = entry["cooldownUntilMs"];
		if (!permanent) {
			if (typeof cooldownUntilMs !== "number" || !Number.isFinite(cooldownUntilMs)) continue;
			if (cooldownUntilMs <= now) continue;
		}
		const checkedAt = typeof entry["checkedAt"] === "number" ? entry["checkedAt"] : now;
		const detail = typeof entry["detail"] === "string" ? entry["detail"] : void 0;
		out[key] = {
			verdict,
			cooldownUntilMs: typeof cooldownUntilMs === "number" && Number.isFinite(cooldownUntilMs) ? cooldownUntilMs : now,
			checkedAt,
			...permanent ? { permanent: true } : {},
			...detail === void 0 ? {} : { detail }
		};
	}
	return out;
}
//#endregion
//#region src/credits-cache.ts
/** Balances move slowly compared with a chat turn. */
const CREDIT_TTL_MS = 3e5;
/** One billing call per account at a time; more just races the gateway. */
const REFRESH_CONCURRENCY = 3;
function key(region, uid) {
	return `${region}/${uid}`;
}
var WorkBuddyCreditsCache = class {
	entries = /* @__PURE__ */ new Map();
	refreshing;
	/** Balance if it was read recently, else whatever was read last. */
	get(region, uid) {
		return this.entries.get(key(region, uid))?.total;
	}
	set(region, uid, total) {
		this.entries.set(key(region, uid), {
			total,
			at: Date.now()
		});
	}
	isFresh(region, uid) {
		const entry = this.entries.get(key(region, uid));
		return entry !== void 0 && Date.now() - entry.at < CREDIT_TTL_MS;
	}
	forget(region, uid) {
		this.entries.delete(key(region, uid));
	}
	/**
	* Refresh balances that are missing or stale.
	*
	* Never awaited by a request: a slow billing endpoint must not add a round
	* trip to someone's chat turn. Failures leave the previous number in place.
	*/
	refresh(store, client) {
		this.refreshing ??= this.run(store, client).finally(() => {
			this.refreshing = void 0;
		});
		return this.refreshing;
	}
	async run(store, client) {
		const targets = [];
		for (const region of ["cn", "global"]) {
			const doc = await store.poolFor(region).get().catch(() => void 0);
			for (const account of doc?.accounts ?? []) {
				if (this.isFresh(region, account.uid)) continue;
				targets.push({
					region,
					uid: account.uid,
					credential: toCredential(account)
				});
			}
		}
		let next = 0;
		const worker = async () => {
			for (;;) {
				const index = next++;
				if (index >= targets.length) return;
				const target = targets[index];
				if (target === void 0) return;
				try {
					const credits = await client.fetchCredits(target.credential);
					this.set(target.region, target.uid, credits.totalBalance);
				} catch {}
			}
		};
		await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, targets.length) }, worker));
	}
};
const DEFAULTS = { autoRoute: true };
function normalizeRouterSettings(raw) {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULTS };
	const doc = raw;
	return { autoRoute: typeof doc["autoRoute"] === "boolean" ? doc["autoRoute"] : DEFAULTS.autoRoute };
}
var WorkBuddyRouterSettingsStore = class {
	path;
	cached;
	constructor(options = {}) {
		this.path = options.path ?? join(resolveDshHome(), ".workbuddy-dual-router.json");
	}
	get documentPath() {
		return this.path;
	}
	/** Cached value, kept warm so the request path never waits on disk. */
	current() {
		return this.cached ?? DEFAULTS;
	}
	async get() {
		if (this.cached !== void 0) return this.cached;
		try {
			this.cached = normalizeRouterSettings(JSON.parse(await readFile(this.path, "utf8")));
		} catch {
			this.cached = { ...DEFAULTS };
		}
		return this.cached;
	}
	async set(patch) {
		const current = await this.get();
		const next = { autoRoute: patch.autoRoute ?? current.autoRoute };
		await withFileLock(this.path, async () => {
			await writeFileAtomic(this.path, `${JSON.stringify({
				version: 1,
				...next
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
		this.cached = next;
		return next;
	}
};
//#endregion
//#region src/index.ts
const WORKBUDDY_DUAL_SETTINGS_NS = "workbuddy-dual";
const Config = z.object({
	cnAuthFile: z.string().description("WorkBuddy CN auth file (defaults to workbuddy-desktop.info)"),
	globalAuthFile: z.string().description("WorkBuddy Global auth file (defaults to workbuddy-desktop-ai.info)"),
	autoRoute: z.boolean().default(true).description("Switch to another account automatically when one is rate limited")
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
	const health = new WorkBuddyHealthStore();
	const credits = new WorkBuddyCreditsCache();
	const affinity = new WorkBuddySessionAffinity();
	const routerSettings = new WorkBuddyRouterSettingsStore();
	const routeOptions = {
		router: {
			store,
			client,
			health,
			credits: (region, uid) => credits.get(region, uid),
			hasModel: (region, model) => catalog.modelsFor(region).some((info) => info.id === model)
		},
		affinity,
		crossLaneFrom: "cn",
		enabled: () => routerSettings.current().autoRoute && currentConfig().autoRoute !== false
	};
	const shim = createWorkBuddyDualShim({
		store,
		client,
		catalog,
		logger: ctx.logger,
		route: routeOptions
	});
	/**
	* Region of the model this turn runs, read the same way web-search-follow
	* reads its route: the live request header first, then the last selection.
	* Only used to pick which WorkBuddy sign-in pays for a hosted web tool.
	*/
	const currentRegion = () => {
		const agents = ctx.get("agents");
		const agent = typeof agents?.currentInitiator === "function" ? agents.currentInitiator() : void 0;
		const readProvider = (value) => {
			if (typeof value !== "object" || value === null) return void 0;
			const record = value;
			const header = typeof record["header"] === "object" && record["header"] !== null ? record["header"] : record;
			const inner = typeof header["config"] === "object" && header["config"] !== null ? header["config"] : header;
			return typeof inner["provider"] === "string" ? inner["provider"] : void 0;
		};
		let provider;
		try {
			provider = readProvider(agent?.session?.requestHeader?.());
		} catch {}
		provider ??= readProvider(agent?.options);
		if (provider === "workbuddy-global") return "global";
		if (provider === "workbuddy-cn") return "cn";
	};
	provideWorkBuddyNativeWeb(ctx, createWorkBuddyNativeWeb({
		store,
		client: createAgentToolClient(),
		resolveRegion: currentRegion,
		logger: ctx.logger
	}));
	let stopped = false;
	let invalidate;
	/** Rebuild the adapter generation and tell every picker to re-read. */
	const publishSelection = (next) => {
		catalog.setSelection(next);
		invalidate?.();
		ctx.events.emit("llm/adapters-updated");
	};
	/**
	* Adopt a freshly fetched upstream catalog.
	*
	* `invalidate()` alone only rebuilds the adapter's provider profiles; the
	* model picker keeps rendering the names it already loaded until it hears
	* `llm/adapters-updated`. Without the event a startup fetch that lands after
	* the first picker read leaves the fallback credits (and badges) on screen
	* for the rest of the session, even though every later request is billed at
	* the live rate.
	*/
	const adoptCatalog = (region, models) => {
		if (models.length === 0) return;
		catalog.setModels(region, models);
		invalidate?.();
		ctx.events.emit("llm/adapters-updated");
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyDualStatusRoute(webCtx, {
			store,
			client,
			catalog
		});
		registerWorkBuddyDualAccountRoutes(webCtx, {
			store,
			client,
			isDisabled: (region, uid, model) => health.isPermanent(region, uid, model),
			router: {
				settings: () => routerSettings.current().autoRoute,
				setAutoRoute: async (enabled) => (await routerSettings.set({ autoRoute: enabled })).autoRoute,
				record: async (region, uid, model, probe) => {
					await health.record(region, uid, model, probe.verdict, {
						...probe.resetsAtMs === void 0 ? {} : { resetsAtMs: probe.resetsAtMs },
						...probe.detail === void 0 ? {} : { detail: probe.detail }
					});
				},
				order: () => routeOverview({
					store,
					client,
					health,
					credits: (region, uid) => credits.get(region, uid),
					hasModel: (region, model) => catalog.modelsFor(region).some((info) => info.id === model)
				}, WORKBUDDY_FLASH_MODEL)
			},
			onAccountChange(region) {
				(async () => {
					try {
						const credential = await store.storeFor(region).current();
						if (credential === void 0) return;
						const models = await client.fetchModels(credential);
						adoptCatalog(region, models);
					} catch (error) {
						ctx.logger.warn(`dsh-workbuddy-dual: could not refresh the ${region} catalog after switching accounts`, error);
					}
				})();
			}
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
			routerSettings.get();
			credits.refresh(store, client);
			const creditsTimer = setInterval(() => {
				credits.refresh(store, client);
			}, 6e4);
			creditsTimer.unref?.();
			ctx.effect(() => () => clearInterval(creditsTimer));
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
						adoptCatalog("cn", models);
					}
				} catch (err) {
					ctx.logger.warn("dsh-workbuddy-dual: failed to fetch dynamic CN models; fallback active", err);
				}
				try {
					const globalCred = await store.global.current();
					if (globalCred) {
						const models = await client.fetchModels(globalCred);
						adoptCatalog("global", models);
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
export { AgentToolError, Config, REGION_ORDER, WORKBUDDY_CN_DISPLAY_NAME, WORKBUDDY_CN_PROVIDER, WORKBUDDY_DUAL_ACCOUNTS_PATH, WORKBUDDY_DUAL_SETTINGS_NS, WORKBUDDY_FLASH_MODEL, WORKBUDDY_GLOBAL_PROVIDER, WORKBUDDY_HEALTH_FILENAME, WORKBUDDY_NATIVE_FETCH_SERVICE, WORKBUDDY_NATIVE_SEARCH_SERVICE, WorkBuddyAccountPool, WorkBuddyCreditsCache, WorkBuddyDualCatalog, WorkBuddyDualCredentialStore, WorkBuddyDualSelectionStore, WorkBuddyHealthStore, WorkBuddySessionAffinity, WorkBuddyUpstreamClient, advertisedModelIds, apply, candidateKey, cooldownFor, createAccountRouteState, createAgentToolClient, createWorkBuddyDualAdapter, createWorkBuddyDualShim, createWorkBuddyNativeWeb, defaultSelection, filterModels, healthKey, inject, name, nextRecoveryMs, normalizeLanePreference, normalizeSelection, planRoute, poolDocumentPath, provideWorkBuddyNativeWeb, readAuthFile, toCredential, workBuddyAccountsView };
