import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { execFileSync } from "node:child_process";
//#region src/auth.ts
/**
* Dual credential resolution for WorkBuddy CN and WorkBuddy Global.
*
* Reads desktop auth files:
* - CN: CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
* - Global: CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info
*
* Each region maintains its own token refresh cache under $DSH_HOME.
*/
const CN_FILENAME = "workbuddy-desktop.info";
const GLOBAL_FILENAME = "workbuddy-desktop-ai.info";
const DESKTOP_REL_CN = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
	CN_FILENAME
];
const DESKTOP_REL_GLOBAL = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
	GLOBAL_FILENAME
];
const OWN_CN_FILENAME = ".workbuddy-dual-cn.json";
const OWN_GLOBAL_FILENAME = ".workbuddy-dual-global.json";
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
function wslDesktopAuthCandidates(home, rel) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...rel), join(roamingAppData, ...rel)];
}
function defaultDesktopCandidatesFor(region) {
	const home = homedir();
	const rel = region === "cn" ? DESKTOP_REL_CN : DESKTOP_REL_GLOBAL;
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...rel)];
	if (process.platform === "win32") return [join(home, "AppData", "Local", ...rel), join(home, "AppData", "Roaming", ...rel)];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...rel);
		return isWsl() ? [...wslDesktopAuthCandidates(home, rel), linux] : [linux];
	}
	return [];
}
function isENOENT(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function optionalString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function parseWorkBuddyAuth(text, defaultRegion) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const doc = parsed;
	const auth = typeof doc["auth"] === "object" && doc["auth"] !== null ? doc["auth"] : doc;
	const account = typeof doc["account"] === "object" && doc["account"] !== null ? doc["account"] : {};
	const accessToken = optionalString(auth["accessToken"]);
	if (accessToken === void 0) return void 0;
	const refreshToken = optionalString(auth["refreshToken"]) ?? "";
	const domain = optionalString(auth["domain"]) ?? (defaultRegion === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn");
	const uid = optionalString(account["uid"]) ?? optionalString(auth["uid"]) ?? "";
	const enterpriseId = optionalString(auth["enterpriseId"]) ?? optionalString(account["enterpriseId"]);
	const nickname = optionalString(account["nickname"]) ?? optionalString(auth["nickname"]);
	let expiresAtMs = 0;
	const rawExpiresAt = optionalNumber(auth["expiresAt"]);
	if (rawExpiresAt !== void 0 && rawExpiresAt > 0) expiresAtMs = rawExpiresAt;
	else {
		const expiresInSec = optionalNumber(auth["expiresIn"]);
		const lastRefreshTime = optionalNumber(auth["lastRefreshTime"]) ?? Date.now();
		if (expiresInSec !== void 0 && expiresInSec > 0) expiresAtMs = lastRefreshTime + expiresInSec * 1e3;
	}
	let refreshExpiresAtMs;
	const rawRefreshExpiresAt = optionalNumber(auth["refreshExpiresAt"]);
	if (rawRefreshExpiresAt !== void 0 && rawRefreshExpiresAt > 0) refreshExpiresAtMs = rawRefreshExpiresAt;
	return {
		accessToken,
		refreshToken,
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain,
		uid,
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop",
		region: defaultRegion
	};
}
var RegionCredentialStore = class {
	region;
	desktopPathOverride;
	ownPath;
	refresh;
	refreshMarginMs;
	inflight;
	constructor(options) {
		this.region = options.region;
		this.desktopPathOverride = options.desktopPathOverride;
		this.ownPath = options.ownPath ?? join(resolveDshHome(), this.region === "cn" ? OWN_CN_FILENAME : OWN_GLOBAL_FILENAME);
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
	}
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	resolveDesktopCandidates() {
		if (this.desktopPathOverride) return [this.desktopPathOverride];
		const envKey = this.region === "cn" ? "WORKBUDDY_CN_AUTH_FILE" : "WORKBUDDY_GLOBAL_AUTH_FILE";
		const envVal = process.env[envKey] ?? (this.region === "cn" ? process.env["WORKBUDDY_AUTH_FILE"] : void 0);
		if (envVal?.trim()) return [envVal.trim()];
		return defaultDesktopCandidatesFor(this.region);
	}
	async desktopFilePresent() {
		for (const p of this.resolveDesktopCandidates()) try {
			if ((await stat(p)).isFile()) return true;
		} catch {}
		return false;
	}
	async readDesktop() {
		for (const p of this.resolveDesktopCandidates()) try {
			const cred = parseWorkBuddyAuth(await readFile(p, "utf8"), this.region);
			if (cred) return cred;
		} catch (e) {
			if (!isENOENT(e)) {}
		}
	}
	async readOwn() {
		try {
			const text = await readFile(this.ownPath, "utf8");
			const doc = JSON.parse(text);
			if (doc && doc.version === 1 && doc.credential) return doc.credential;
		} catch {}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			const doc = {
				version: 1,
				credential
			};
			await writeFileAtomic(this.ownPath, `${JSON.stringify(doc, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) throw new Error(`workbuddy (${this.region}): no signed-in account found. Please sign in to the WorkBuddy ${this.region === "cn" ? "CN" : "Global"} app.`);
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	async refreshNow(credential) {
		if (!credential.refreshToken) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy (${this.region}): token expired and no refresh token available; sign in again in the app.`);
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (err) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy (${this.region}): token refresh failed (${String(err)}); sign in again in the app.`);
		}
	}
	async status() {
		try {
			const cred = await this.current();
			if (!cred) return {
				state: "signed-out",
				region: this.region
			};
			return {
				state: "signed-in",
				region: this.region,
				expiresAtMs: cred.expiresAtMs,
				...cred.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: cred.refreshExpiresAtMs },
				...cred.nickname === void 0 ? {} : { nickname: cred.nickname },
				...cred.domain === void 0 ? {} : { domain: cred.domain },
				source: cred.source
			};
		} catch {
			return {
				state: "signed-out",
				region: this.region
			};
		}
	}
};
var WorkBuddyDualCredentialStore = class {
	cn;
	global;
	constructor(options) {
		this.cn = new RegionCredentialStore({
			region: "cn",
			desktopPathOverride: options.cnPathOverride,
			refresh: options.refreshCN
		});
		this.global = new RegionCredentialStore({
			region: "global",
			desktopPathOverride: options.globalPathOverride,
			refresh: options.refreshGlobal
		});
	}
	storeFor(region) {
		return region === "cn" ? this.cn : this.global;
	}
};
//#endregion
//#region src/catalog.ts
const FALLBACK_CN_MODELS = [
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.03 credits",
			badges: ["独家优惠"],
			free: false
		},
		region: "cn"
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00 credits",
			badges: ["限时免费"],
			free: true
		},
		region: "cn"
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		},
		region: "cn"
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.06",
			free: false
		},
		region: "cn"
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.25 credits",
			free: false
		},
		region: "cn"
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62 credits",
			free: false
		},
		region: "cn"
	}
];
const FALLBACK_GLOBAL_MODELS = [
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			badges: ["Free now"],
			free: true
		},
		region: "global"
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x6.67",
			free: false
		},
		region: "global"
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x3.47",
			free: false
		},
		region: "global"
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		},
		region: "global"
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.99",
			free: false
		},
		region: "global"
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		},
		region: "global"
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			badges: ["Free now"],
			free: true
		},
		region: "global"
	}
];
var WorkBuddyDualCatalog = class {
	cnModels = FALLBACK_CN_MODELS;
	globalModels = FALLBACK_GLOBAL_MODELS;
	modelsFor(region) {
		return region === "cn" ? this.cnModels : this.globalModels;
	}
	setModels(region, models) {
		if (region === "cn") this.cnModels = [...models];
		else this.globalModels = [...models];
	}
};
//#endregion
//#region src/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA_CN = "CLI/2.63.2 CodeBuddy/2.63.2";
const CLIENT_UA_GLOBAL = "WorkBuddy/5.3.14 WorkBuddy/5.3.14 CLI/2.115.0";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
function classifyUpstreamError(status, body) {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate";
	const lowered = body.toLowerCase();
	if (HARD_CREDIT_MARKERS.some((marker) => lowered.includes(marker))) return "credit";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
function chatBase(region) {
	return region === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(region) {
	return region === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(region) {
	return region === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function commonHeaders(credential) {
	const isGlobal = credential.region === "global";
	return {
		"Accept": "application/json, text/plain, */*",
		"Origin": originReferer(credential.region),
		"Referer": `${originReferer(credential.region)}/`,
		"User-Agent": isGlobal ? CLIENT_UA_GLOBAL : CLIENT_UA_CN,
		...isGlobal ? {
			"X-IDE-Type": "WorkBuddy",
			"X-IDE-Name": "WorkBuddy",
			"X-IDE-Version": "5.3.14",
			"X-Product-Version": "5.3.14"
		} : {}
	};
}
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		"X-Product": "SaaS",
		...credential.uid ? { "X-User-Id": credential.uid } : { "X-No-User-Id": "1" },
		...credential.enterpriseId ? { "X-Enterprise-Id": credential.enterpriseId } : { "X-No-Enterprise-Id": "1" },
		"X-Domain": credential.domain || (credential.region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn")
	};
}
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId) headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid) headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId) {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	headers["X-Domain"] = credential.domain || (credential.region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn");
	return headers;
}
async function readEnvelope(response) {
	try {
		const raw = await response.text();
		const parsed = JSON.parse(raw);
		return {
			code: typeof parsed["code"] === "number" ? parsed["code"] : response.ok ? 0 : -1,
			msg: typeof parsed["msg"] === "string" ? parsed["msg"] : void 0,
			data: parsed["data"]
		};
	} catch {
		return { code: response.ok ? 0 : -1 };
	}
}
var WorkBuddyUpstreamClient = class {
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential.region)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal ? { signal } : {}
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential.region)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw new Error(`Token refresh failed HTTP ${response.status}: ${envelope.msg ?? "unknown error"}`);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (!accessToken) throw new Error("Refresh endpoint returned empty accessToken");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"]) outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"]) outcome.domain = data["domain"];
		return outcome;
	}
	async fetchModels(credential) {
		const region = credential.region;
		const base = chatBase(region);
		try {
			const configRes = await fetch(`${base}/v3/config`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Accept": "application/json",
					...commonHeaders(credential)
				},
				signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
			});
			if (configRes.ok) {
				const env = await readEnvelope(configRes);
				if (env.code === 0 && typeof env.data === "object" && env.data !== null) {
					const cfg = env.data;
					if (Array.isArray(cfg["models"]) && cfg["models"].length > 0) return this.parseModelsList(cfg["models"], region);
				}
			}
		} catch {}
		if (region === "cn") {
			const res = await fetch(`${base}/console/enterprises/personal/models`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Accept": "application/json",
					"Origin": originReferer(region),
					"Referer": `${originReferer(region)}/`,
					"User-Agent": CLIENT_UA_CN
				},
				signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
			});
			if (res.ok) {
				const env = await readEnvelope(res);
				if (env.code === 0 && typeof env.data === "object" && env.data !== null) {
					const data = env.data;
					if (Array.isArray(data["models"])) return this.parseModelsList(data["models"], region);
				}
			}
		}
		throw new Error(`Failed to fetch models for ${region}`);
	}
	parseModelsList(rawList, region) {
		const result = [];
		for (const item of rawList) {
			if (typeof item !== "object" || item === null) continue;
			const m = item;
			const id = typeof m["id"] === "string" ? m["id"] : "";
			if (!id || m["disabled"] === true) continue;
			const name = typeof m["name"] === "string" && m["name"] ? m["name"] : id;
			const contextWindow = typeof m["maxInputTokens"] === "number" ? m["maxInputTokens"] : typeof m["maxAllowedSize"] === "number" ? m["maxAllowedSize"] : 2e5;
			const maxTokens = typeof m["maxOutputTokens"] === "number" ? m["maxOutputTokens"] : 32e3;
			const supportsImages = m["supportsImages"] === true && m["disabledMultimodal"] !== true;
			let reasoning;
			if (typeof m["reasoning"] === "object" && m["reasoning"] !== null) {
				const r = m["reasoning"];
				const supportedEfforts = Array.isArray(r["supportedEfforts"]) ? r["supportedEfforts"].filter((x) => typeof x === "string") : void 0;
				reasoning = {
					supports: true,
					onlyReasoning: m["onlyReasoning"] === true,
					supportedEfforts,
					defaultEffort: typeof r["defaultEffort"] === "string" ? r["defaultEffort"] : typeof r["effort"] === "string" ? r["effort"] : void 0,
					canDisableThinking: r["canDisableThinking"] === true
				};
			} else if (m["supportsReasoning"] === true) reasoning = {
				supports: true,
				onlyReasoning: m["onlyReasoning"] === true
			};
			const credits = typeof m["credits"] === "string" ? m["credits"] : void 0;
			const badges = [];
			if (Array.isArray(m["tags"])) {
				for (const tag of m["tags"]) if (typeof tag === "string") {
					if (tag.startsWith("badge:")) {
						const parts = tag.split(":");
						if (parts[1]) badges.push(parts[1]);
					} else if (tag === "限时免费" || tag === "Free now") badges.push(tag);
				}
			}
			const free = credits === "x0.00" || credits === "x0.00 credits" || badges.includes("限时免费") || badges.includes("Free now");
			result.push({
				id,
				name,
				contextWindow,
				maxTokens,
				supportsImages,
				reasoning,
				billing: {
					credits,
					badges: badges.length > 0 ? badges : void 0,
					free
				},
				region
			});
		}
		return result;
	}
	async fetchCredits(credential) {
		const base = billingBase(credential.region);
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw new Error(`Fetch credits failed HTTP ${response.status}`);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const respWrapper = typeof data["Response"] === "object" && data["Response"] !== null ? data["Response"] : {};
		const dataInner = typeof respWrapper["Data"] === "object" && respWrapper["Data"] !== null ? respWrapper["Data"] : {};
		const rawAccounts = Array.isArray(dataInner["Accounts"]) ? dataInner["Accounts"] : [];
		let totalBalance = 0;
		const accounts = [];
		for (const a of rawAccounts) {
			if (typeof a !== "object" || a === null) continue;
			const item = a;
			const name = typeof item["PackageName"] === "string" ? item["PackageName"] : "Credits Package";
			const remain = typeof item["CycleCapacityRemain"] === "number" ? item["CycleCapacityRemain"] : typeof item["CapacityRemain"] === "number" ? item["CapacityRemain"] : 0;
			const total = typeof item["CycleCapacitySize"] === "number" ? item["CycleCapacitySize"] : typeof item["CapacitySize"] === "number" ? item["CapacitySize"] : 0;
			totalBalance += remain;
			accounts.push({
				name,
				balance: remain,
				total
			});
		}
		return {
			accounts,
			totalBalance
		};
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDY_DUAL_VERSION = "0.1.0";
//#endregion
//#region src/host-heartbeat.ts
const WORKBUDDY_DUAL_HEARTBEAT_FILENAME = ".workbuddy-dual-heartbeat.json";
const HEARTBEAT_FORMAT_VERSION = 1;
function workbuddyHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDY_DUAL_HEARTBEAT_FILENAME);
}
async function writeHostHeartbeat() {
	const doc = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-workbuddy-dual",
		pluginVersion: WORKBUDDY_DUAL_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(doc), "utf8");
	} catch {}
}
async function clearHostHeartbeat() {
	try {
		await rm(workbuddyHostHeartbeatPath(), { force: true });
	} catch {}
}
async function readHostHeartbeat() {
	try {
		const raw = await readFile(workbuddyHostHeartbeatPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-workbuddy-dual" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: "dsh-workbuddy-dual",
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
export { WORKBUDDY_DUAL_VERSION as a, FALLBACK_GLOBAL_MODELS as c, writeHostHeartbeat as i, WorkBuddyDualCatalog as l, isHeartbeatProcessAlive as n, WorkBuddyUpstreamClient as o, readHostHeartbeat as r, FALLBACK_CN_MODELS as s, clearHostHeartbeat as t, WorkBuddyDualCredentialStore as u };
