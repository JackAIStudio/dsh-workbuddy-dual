import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
//#region src/decrypt.ts
const keyCache = /* @__PURE__ */ new Map();
function isWbEncryptedField(value) {
	return typeof value === "object" && value !== null && value["$wbEncrypted"] === 1 && typeof value["envelope"] === "string";
}
function findWorkBuddyExecutable(region) {
	const envKey = region === "cn" ? "WORKBUDDY_CN_EXE" : "WORKBUDDY_GLOBAL_EXE";
	const custom = process.env[envKey] ?? process.env["WORKBUDDY_EXE"];
	if (custom && existsSync(custom)) return custom;
	const home = homedir();
	if (process.platform === "darwin") {
		const candidates = region === "cn" ? ["/Applications/WorkBuddy.app/Contents/MacOS/Electron", join(home, "Applications/WorkBuddy.app/Contents/MacOS/Electron")] : ["/Applications/WorkBuddy AI.app/Contents/MacOS/Electron", join(home, "Applications/WorkBuddy AI.app/Contents/MacOS/Electron")];
		for (const c of candidates) if (existsSync(c)) return c;
	} else if (process.platform === "win32") {
		const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
		const candidates = region === "cn" ? [join(local, "Programs", "WorkBuddy", "WorkBuddy.exe")] : [join(local, "Programs", "WorkBuddy AI", "WorkBuddy AI.exe")];
		for (const c of candidates) if (existsSync(c)) return c;
	} else if (process.platform === "linux") {
		const candidates = region === "cn" ? ["/opt/WorkBuddy/workbuddy", "/usr/bin/workbuddy"] : ["/opt/WorkBuddy AI/workbuddy", "/usr/bin/workbuddy-ai"];
		for (const c of candidates) if (existsSync(c)) return c;
	}
}
function getOrDeriveMasterKey(keyId, region) {
	const cached = keyCache.get(keyId);
	if (cached) return cached;
	const exe = findWorkBuddyExecutable(region);
	if (!exe) return void 0;
	try {
		const out = execFileSync(exe, ["-e", "try{const s=process._linkedBinding(\"electron_browser_workbuddy_storage\");process.stdout.write(s.loggerGet())}catch(e){process.exit(1)}process.exit(0);"], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			encoding: "utf8",
			timeout: 4e3,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		const payload = JSON.parse(out);
		if (!payload || payload.version !== 1 || typeof payload.atRestSecretKey !== "string") return;
		const rawKey = createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
		const derivedKeyId = createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
		keyCache.set(derivedKeyId, rawKey);
		if (derivedKeyId === keyId) return rawKey;
	} catch {}
	return keyCache.get(keyId);
}
function lengthPrefix(s) {
	const bytes = Buffer.from(s, "utf8");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}
function decryptWbString(field, region) {
	if (typeof field === "string" && field.trim() !== "") return field.trim();
	if (!isWbEncryptedField(field)) return void 0;
	try {
		const envJson = Buffer.from(field.envelope, "base64").toString("utf8");
		const envelope = JSON.parse(envJson);
		if (!envelope || envelope.suite !== 1 || !envelope.keyId) return void 0;
		const key = getOrDeriveMasterKey(envelope.keyId, region);
		if (!key) return void 0;
		const aad = Buffer.concat([
			Buffer.from("WB-AAD\0", "ascii"),
			Buffer.from([1]),
			lengthPrefix("WBEV1"),
			lengthPrefix("sym-v1"),
			Buffer.from([
				0,
				0,
				0,
				1
			]),
			lengthPrefix(envelope.keyId),
			Buffer.from([
				2,
				0,
				0
			])
		]);
		const nonce = Buffer.from(envelope.nonce, "base64");
		const tag = Buffer.from(envelope.authTag, "base64");
		const ciphertext = Buffer.from(envelope.ciphertext, "base64");
		const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
		return plaintext.trim() !== "" ? plaintext.trim() : void 0;
	} catch {
		return;
	}
}
//#endregion
//#region src/accounts.ts
/**
* The account pool: several WorkBuddy sign-ins per region, one of them active.
*
* Before this file the plugin held exactly one credential per region (the
* desktop app's sign-in, or the plugin's own refreshed copy of it). That made
* "switch to the account that can still run flash" a manual file edit. Here we
* keep a list instead, plus the id of the account the user picked; the active
* entry is what the credential store resolves.
*
* Storage lives next to the plugin's other state under the DSH home, so the
* desktop and Web hosts read the same document and therefore share the same
* selection. The document holds live bearer tokens, so it is written with the
* same 0600/0700 modes the single-credential cache used.
*/
const WORKBUDDY_POOL_FILENAMES = {
	cn: ".workbuddy-dual-accounts-cn.json",
	global: ".workbuddy-dual-accounts-global.json"
};
/** Absolute path of one region's pool document. */
function poolDocumentPath(region) {
	return join(resolveDshHome(), WORKBUDDY_POOL_FILENAMES[region]);
}
function emptyDocument(region) {
	return {
		version: 1,
		region,
		accounts: [],
		updatedAt: 0
	};
}
/**
* A full document with an explicit selection.
*
* `activeUid` is optional, so "clear the selection" has to build the object
* without the key at all; spreading `{ ...doc, activeUid: undefined }` under
* `exactOptionalPropertyTypes` still counts as present at compile time and
* would rely on JSON dropping it.
*/
function withAccounts(doc, accounts, activeUid) {
	return {
		version: 1,
		region: doc.region,
		accounts,
		...activeUid === void 0 ? {} : { activeUid },
		updatedAt: doc.updatedAt
	};
}
function optionalString$1(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function optionalNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Accept only a complete entry; a half-written token pair is not an account. */
function normalizeAccount(raw, region) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const doc = raw;
	const uid = optionalString$1(doc["uid"]);
	const accessToken = optionalString$1(doc["accessToken"]);
	if (uid === void 0 || accessToken === void 0) return void 0;
	const now = Date.now();
	const refreshExpiresAtMs = optionalNumber$1(doc["refreshExpiresAtMs"]);
	const addedAt = optionalNumber$1(doc["addedAt"]) ?? now;
	return {
		uid,
		region,
		...optionalString$1(doc["nickname"]) === void 0 ? {} : { nickname: optionalString$1(doc["nickname"]) },
		...optionalString$1(doc["label"]) === void 0 ? {} : { label: optionalString$1(doc["label"]) },
		accessToken,
		refreshToken: optionalString$1(doc["refreshToken"]) ?? "",
		expiresAtMs: optionalNumber$1(doc["expiresAtMs"]) ?? 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString$1(doc["domain"]) ?? (region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn"),
		...optionalString$1(doc["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString$1(doc["enterpriseId"]) },
		addedAt,
		updatedAt: optionalNumber$1(doc["updatedAt"]) ?? addedAt
	};
}
/** Reject a document whose region disagrees with its filename. */
function normalizePoolDocument(raw, region) {
	if (typeof raw !== "object" || raw === null) return emptyDocument(region);
	const doc = raw;
	const rawAccounts = Array.isArray(doc["accounts"]) ? doc["accounts"] : [];
	const accounts = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of rawAccounts) {
		const account = normalizeAccount(item, region);
		if (account === void 0 || seen.has(account.uid)) continue;
		seen.add(account.uid);
		accounts.push(account);
	}
	const activeUid = optionalString$1(doc["activeUid"]);
	return {
		version: 1,
		region,
		accounts,
		...activeUid !== void 0 && seen.has(activeUid) ? { activeUid } : {},
		updatedAt: optionalNumber$1(doc["updatedAt"]) ?? 0
	};
}
/** Turn a pool entry into the credential shape the shim already consumes. */
function toCredential(account) {
	return {
		accessToken: account.accessToken,
		refreshToken: account.refreshToken,
		expiresAtMs: account.expiresAtMs,
		...account.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: account.refreshExpiresAtMs },
		domain: account.domain,
		uid: account.uid,
		...account.enterpriseId === void 0 ? {} : { enterpriseId: account.enterpriseId },
		...account.nickname === void 0 ? {} : { nickname: account.nickname },
		source: "pool",
		region: account.region
	};
}
/** Fold a (possibly refreshed) credential back into its pool entry. */
function mergeCredential(account, credential) {
	return {
		...account,
		accessToken: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAtMs: credential.expiresAtMs,
		...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
		domain: credential.domain,
		...credential.enterpriseId === void 0 ? {} : { enterpriseId: credential.enterpriseId },
		...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
		updatedAt: Date.now()
	};
}
/** Reads and writes one region's pool with atomic replacement. */
var WorkBuddyAccountPool = class {
	region;
	path;
	cached;
	/** Modification time of the document the cache was read from. */
	cachedMtimeMs = -1;
	constructor(region, options = {}) {
		this.region = region;
		this.path = options.path ?? poolDocumentPath(region);
	}
	/** Absolute document path; surfaced by diagnostics only. */
	get documentPath() {
		return this.path;
	}
	async get() {
		const mtimeMs = await stat(this.path).then((file) => file.mtimeMs).catch(() => -1);
		if (this.cached !== void 0 && mtimeMs === this.cachedMtimeMs) return this.cached;
		try {
			const raw = JSON.parse(await readFile(this.path, "utf8"));
			this.cached = normalizePoolDocument(raw, this.region);
		} catch {
			this.cached = emptyDocument(this.region);
		}
		this.cachedMtimeMs = mtimeMs;
		return this.cached;
	}
	/** Re-read from disk on the next `get`; used when another host may have written. */
	invalidate() {
		this.cached = void 0;
		this.cachedMtimeMs = -1;
	}
	/** The account the user selected, if the pool still holds it. */
	async active() {
		const doc = await this.get();
		if (doc.activeUid === void 0) return void 0;
		return doc.accounts.find((account) => account.uid === doc.activeUid);
	}
	async find(uid) {
		return (await this.get()).accounts.find((account) => account.uid === uid);
	}
	/** Persist a whole document after normalizing it against the region. */
	async replace(doc) {
		const normalized = normalizePoolDocument({
			...doc,
			updatedAt: Date.now()
		}, this.region);
		await withFileLock(this.path, async () => {
			await writeFileAtomic(this.path, `${JSON.stringify(normalized, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
		this.cached = normalized;
		this.cachedMtimeMs = await stat(this.path).then((file) => file.mtimeMs).catch(() => -1);
		return normalized;
	}
	/**
	* Add or replace one account, keeping its `addedAt` and label.
	*
	* Adding through the panel is also how an account becomes selectable, so a
	* first-time add selects it; re-capturing an existing account never steals
	* the selection from whatever the user already chose.
	*/
	async upsert(credential, options = {}) {
		const doc = await this.get();
		const existing = doc.accounts.find((account) => account.uid === credential.uid);
		const now = Date.now();
		const merged = mergeCredential(existing ?? {
			uid: credential.uid,
			region: this.region,
			...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
			accessToken: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAtMs: credential.expiresAtMs,
			...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
			domain: credential.domain,
			...credential.enterpriseId === void 0 ? {} : { enterpriseId: credential.enterpriseId },
			addedAt: now,
			updatedAt: now
		}, credential);
		const labelled = options.label === void 0 ? merged : {
			...merged,
			label: options.label
		};
		const accounts = existing === void 0 ? [...doc.accounts, labelled] : doc.accounts.map((account) => account.uid === labelled.uid ? labelled : account);
		const select = options.select ?? existing === void 0;
		return await this.replace(withAccounts(doc, accounts, select ? labelled.uid : doc.activeUid));
	}
	/** Store a refreshed token pair for one account. */
	async update(uid, credential) {
		const doc = await this.get();
		if (!doc.accounts.some((account) => account.uid === uid)) return void 0;
		return await this.replace({
			...doc,
			accounts: doc.accounts.map((account) => account.uid === uid ? mergeCredential(account, credential) : account)
		});
	}
	/** Rename an account (label only; identity stays the uid). */
	async relabel(uid, label) {
		const doc = await this.get();
		if (!doc.accounts.some((account) => account.uid === uid)) return void 0;
		return await this.replace({
			...doc,
			accounts: doc.accounts.map((account) => account.uid === uid ? {
				...account,
				label
			} : account)
		});
	}
	async remove(uid) {
		const doc = await this.get();
		const accounts = doc.accounts.filter((account) => account.uid !== uid);
		const keepsSelection = doc.activeUid !== void 0 && doc.activeUid !== uid;
		return await this.replace(withAccounts(doc, accounts, keepsSelection ? doc.activeUid : void 0));
	}
	/** Select an existing account; `undefined` returns to the desktop app's sign-in. */
	async select(uid) {
		const doc = await this.get();
		if (uid !== void 0 && !doc.accounts.some((account) => account.uid === uid)) throw new Error(`account not in the ${this.region} pool: ${uid}`);
		return await this.replace(withAccounts(doc, doc.accounts, uid));
	}
	/** Drop the whole document, including every stored token. */
	async clear() {
		await rm(this.path, { force: true });
		await rm(`${this.path}.lock`, { force: true });
		this.cached = emptyDocument(this.region);
		this.cachedMtimeMs = -1;
	}
};
//#endregion
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
	const accessToken = decryptWbString(auth["accessToken"], defaultRegion);
	if (accessToken === void 0) return void 0;
	const refreshToken = decryptWbString(auth["refreshToken"], defaultRegion) ?? "";
	const domain = optionalString(auth["domain"]) ?? (defaultRegion === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn");
	const uid = optionalString(account["uid"]) ?? optionalString(auth["uid"]) ?? "";
	const enterpriseId = optionalString(auth["enterpriseId"]) ?? optionalString(account["enterpriseId"]);
	const nickname = decryptWbString(account["nickname"] ?? auth["nickname"], defaultRegion);
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
	poolRef;
	inflight;
	constructor(options) {
		this.region = options.region;
		this.desktopPathOverride = options.desktopPathOverride;
		this.ownPath = options.ownPath ?? join(resolveDshHome(), this.region === "cn" ? OWN_CN_FILENAME : OWN_GLOBAL_FILENAME);
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.poolRef = options.pool;
	}
	/** The pool, when this store was built with one. */
	get pool() {
		return this.poolRef;
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
		const pooled = await this.poolRef?.active();
		if (pooled !== void 0) return toCredential(pooled);
		return await this.fallback();
	}
	/**
	* The sign-in the plugin would use with no pool selection: the desktop
	* app's credential, or this plugin's own refreshed copy of it.
	*
	* Kept separate from `current()` so the panel can describe the fallback row
	* honestly while a pooled account is in use.
	*/
	async fallback() {
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
				source: credential.source === "pool" ? "pool" : "dsh"
			};
			if (credential.source === "pool") await this.poolRef?.update(credential.uid, refreshed);
			else await this.saveOwn(refreshed);
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
	pools;
	constructor(options) {
		this.pools = {
			cn: new WorkBuddyAccountPool("cn", { path: options.poolPaths?.cn }),
			global: new WorkBuddyAccountPool("global", { path: options.poolPaths?.global })
		};
		this.cn = new RegionCredentialStore({
			region: "cn",
			desktopPathOverride: options.cnPathOverride,
			pool: this.pools.cn,
			refresh: options.refreshCN
		});
		this.global = new RegionCredentialStore({
			region: "global",
			desktopPathOverride: options.globalPathOverride,
			pool: this.pools.global,
			refresh: options.refreshGlobal
		});
	}
	storeFor(region) {
		return region === "cn" ? this.cn : this.global;
	}
	poolFor(region) {
		return region === "cn" ? this.pools.cn : this.pools.global;
	}
};
//#endregion
//#region src/selection.ts
/** The open default: every lane enabled, every catalog model advertised. */
function defaultLanePreference() {
	return {
		enabled: true,
		mode: "all",
		models: []
	};
}
/** Fresh selection for a deployment with no stored preference. */
function defaultSelection() {
	return {
		cn: defaultLanePreference(),
		global: defaultLanePreference()
	};
}
/** Normalize one lane: de-duplicated trimmed ids, `all` carries no list. */
function normalizeLanePreference(input) {
	const raw = isRecord(input) ? input : {};
	const enabled = typeof raw["enabled"] === "boolean" ? raw["enabled"] : true;
	const models = normalizeModelIds((Array.isArray(raw["models"]) ? raw["models"] : []).filter((id) => typeof id === "string"));
	const mode = (raw["mode"] === "all" || raw["mode"] === "selected" ? raw["mode"] : void 0) ?? (models.length === 0 ? "all" : "selected");
	return {
		enabled,
		mode,
		models: mode === "all" ? [] : models
	};
}
/** Normalize a whole selection document, keeping valid per-lane defaults. */
function normalizeSelection(input) {
	const raw = isRecord(input) ? input : {};
	return {
		cn: normalizeLanePreference(raw["cn"]),
		global: normalizeLanePreference(raw["global"])
	};
}
/** Trim, drop blanks, and preserve first-seen order. */
function normalizeModelIds(ids) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const id of ids) {
		const trimmed = typeof id === "string" ? id.trim() : "";
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}
/** Filter one lane's full catalog into what the model pickers should show. */
function filterModels(models, lane) {
	if (!lane.enabled) return [];
	if (lane.mode === "all") return models;
	const wanted = new Set(lane.models);
	return models.filter((model) => wanted.has(model.id));
}
/** The exact ids a lane currently advertises, for tests and diagnostics. */
function advertisedModelIds(models, lane) {
	return filterModels(models, lane).map((model) => model.id);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/catalog.ts
/**
* Placeholder catalog used only until the first `/v3/config` read lands.
*
* The upstream publishes credits as a multiplier and changes it without
* notice (DeepSeek-V4.1-Flash went 0.03 -> 0.11), so these numbers are a
* best-effort snapshot of the same values, kept in step with the gateway at
* the time of writing. Nothing here is authoritative: the picker replaces
* every entry with the live catalog as soon as it arrives, and billing always
* happens at the gateway's own rate.
*/
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
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.11 credits",
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
			supportedEfforts: ["low", "high"],
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
			supportedEfforts: [
				"low",
				"medium",
				"high"
			],
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
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
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
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"max"
			],
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
			supportedEfforts: [
				"low",
				"medium",
				"high"
			],
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
	live = {
		cn: false,
		global: false
	};
	selection;
	/** Every model the upstream catalogs know about, before user filtering. */
	modelsFor(region) {
		return region === "cn" ? this.cnModels : this.globalModels;
	}
	/** Models the harness is allowed to advertise; optional when open. */
	selectedModelsFor(region) {
		const selection = this.selection;
		if (!selection) return this.modelsFor(region);
		return filterModels(this.modelsFor(region), selection[region]);
	}
	setSelection(selection) {
		this.selection = selection;
	}
	/** Whether the upstream catalog has answered for this lane (vs. fallback). */
	isLive(region) {
		return this.live[region];
	}
	setModels(region, models) {
		if (region === "cn") {
			this.cnModels = [...models];
			this.live = {
				...this.live,
				cn: true
			};
		} else {
			this.globalModels = [...models];
			this.live = {
				...this.live,
				global: true
			};
		}
	}
};
//#endregion
//#region src/selection-store.ts
/**
* Durable storage for the user's per-lane model selection.
*
* The document lives beside the plugin's other state under the DSH home. It is
* deliberately separate from the Harness settings document: the model page is
* served by this plugin over its own loopback route, which works on both the
* Web and desktop hosts, and a single small file is easier to recover than a
* filed-down section of a shared settings tree.
*/
const WORKBUDDY_DUAL_SELECTION_FILENAME = ".workbuddy-dual-models.json";
/** Default absolute path of the selection document. */
function selectionDocumentPath() {
	return join(resolveDshHome(), WORKBUDDY_DUAL_SELECTION_FILENAME);
}
/** Reads and writes the selection document with atomic replacement. */
var WorkBuddyDualSelectionStore = class {
	path;
	cached = defaultSelection();
	loaded = false;
	constructor(options = {}) {
		this.path = options.path ?? selectionDocumentPath();
	}
	/** Absolute document path; surfaced by diagnostics only. */
	get documentPath() {
		return this.path;
	}
	/** Current selection, refreshing from disk when it might have changed. */
	async get() {
		await this.load();
		return this.cached;
	}
	/** Persist a whole selection after normalizing it. */
	async replace(selection) {
		await this.load();
		const normalized = normalizeSelection(selection);
		const doc = {
			version: 1,
			...normalized,
			updatedAt: Date.now()
		};
		await withFileLock(this.path, async () => {
			await writeFileAtomic(this.path, `${JSON.stringify(doc, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
		this.cached = normalized;
		return normalized;
	}
	/** Merge one lane's patch into the stored preference. */
	async updateLanes(patch) {
		const current = await this.get();
		const next = {
			cn: patch.cn === void 0 ? current.cn : {
				...current.cn,
				...patch.cn
			},
			global: patch.global === void 0 ? current.global : {
				...current.global,
				...patch.global
			}
		};
		return this.replace(next);
	}
	async load() {
		if (this.loaded) return;
		try {
			const raw = await readFile(this.path, "utf8");
			const parsed = JSON.parse(raw);
			this.cached = normalizeSelection(parsed);
		} catch {
			this.cached = defaultSelection();
		}
		this.loaded = true;
	}
};
//#endregion
//#region src/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const FALLBACK_APP_VERSION = {
	cn: "5.8.3",
	global: "5.6.2"
};
const APP_INFO_PLIST = {
	cn: "/Applications/WorkBuddy.app/Contents/Info.plist",
	global: "/Applications/WorkBuddy AI.app/Contents/Info.plist"
};
const CLI_VERSION = {
	cn: "2.63.2",
	global: "2.115.0"
};
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** A probe asks for one token, so a healthy answer costs a fraction of a credit. */
const PROBE_TIMEOUT_MS = 45e3;
const PROBE_MAX_TOKENS = 1;
/** Gateway codes that mean "this account cannot run this model right now". */
const PROBE_BLOCK_CODES = [
	"6004",
	"11140",
	"14018"
];
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
/**
* The gateway answers a rate-limited stream with an SSE frame carrying the
* business code and, for 6004, the exact moment the model frees up. Reading
* that timestamp beats estimating from credits: it is the upstream's own
* schedule.
*/
function parseResetTime(text) {
	const match = /将在\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
	if (match === null) return void 0;
	const [, day, clock] = match;
	const parsed = Date.parse(`${day}T${clock}+08:00`);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** First gateway business code in a body or SSE frame. */
function parseBusinessCode(text) {
	return /"code"\s*:\s*(\d+)/.exec(text)?.[1];
}
function probeVerdictFor(status, code) {
	if (code === "6004") return "rate-limited";
	if (code === "11140") return "banned";
	if (code === "14018") return "no-credit";
	if (status === 429) return "rate-limited";
	if (status === 401 || status === 403) return "auth";
	return "error";
}
/** Strip anything token-shaped before a message reaches the panel. */
function probeDetail(text) {
	const cleaned = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]").replace(/\s+/gu, " ").trim();
	return cleaned === "" ? void 0 : cleaned.slice(0, 200);
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
/** Read the installed WorkBuddy app version; the gateway checks this header. */
function appVersion(region) {
	const plist = APP_INFO_PLIST[region];
	if (existsSync(plist)) try {
		const value = execFileSync("/usr/libexec/PlistBuddy", [
			"-c",
			"Print :CFBundleShortVersionString",
			plist
		], {
			encoding: "utf8",
			timeout: 2e3,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
		if (value) return value;
	} catch {}
	return FALLBACK_APP_VERSION[region];
}
function clientUserAgent(region) {
	const version = appVersion(region);
	return region === "global" ? `WorkBuddy/${version} WorkBuddy/${version} CLI/${CLI_VERSION.global}` : `CLI/${CLI_VERSION.cn} CodeBuddy/${CLI_VERSION.cn}`;
}
/** The official gateway's trace triplet shares one trace id. */
function gatewayRequestHeaders() {
	const traceId = randomBytes(16).toString("hex");
	const spanId = randomBytes(8).toString("hex");
	const parentSpanId = randomBytes(8).toString("hex");
	return {
		"x-requested-with": "XMLHttpRequest",
		"x-codebuddy-request": "1",
		"X-Conversation-ID": randomUUID(),
		"X-Conversation-Request-ID": randomUUID(),
		"X-Conversation-Message-ID": randomUUID(),
		"X-Request-ID": randomUUID(),
		"acp-connection-id": randomUUID(),
		"X-Agent-Intent": "craft",
		"X-Agent-Purpose": "conversation",
		"traceparent": `00-${traceId}-${spanId}-01`,
		"b3": `${traceId}-${spanId}-1-${parentSpanId}`,
		"X-B3-TraceId": traceId,
		"X-B3-ParentSpanId": parentSpanId,
		"X-B3-SpanId": spanId,
		"X-B3-Sampled": "1",
		"X-Trace-ID": traceId
	};
}
function commonHeaders(credential) {
	const version = appVersion(credential.region);
	return {
		"Accept": "application/json, text/plain, */*",
		"Origin": originReferer(credential.region),
		"Referer": `${originReferer(credential.region)}/`,
		"User-Agent": clientUserAgent(credential.region),
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Name": "WorkBuddy",
		"X-IDE-Version": version,
		"X-Product-Version": version,
		"X-Private-Data": "true"
	};
}
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		"X-Product": "SaaS",
		...gatewayRequestHeaders(),
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
function parseCatalogModels(rawList, region) {
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
			const declaredEffort = [
				r["defaultEffort"],
				r["effort"],
				m["defaultEffort"]
			].find((value) => typeof value === "string" && value.trim() !== "");
			reasoning = {
				supports: true,
				onlyReasoning: m["onlyReasoning"] === true,
				supportedEfforts,
				defaultEffort: declaredEffort,
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
	async probeModel(credential, model) {
		const startedAt = Date.now();
		const body = JSON.stringify({
			model,
			messages: [{
				role: "system",
				content: "You are a helpful assistant."
			}, {
				role: "user",
				content: "ok"
			}],
			max_tokens: PROBE_MAX_TOKENS,
			stream: true
		});
		const checkedAt = startedAt;
		const finish = (verdict, extra = {}) => ({
			verdict,
			...extra.code === void 0 ? {} : { code: extra.code },
			...extra.head === void 0 ? {} : { detail: probeDetail(extra.head) },
			...extra.head === void 0 ? {} : { resetsAtMs: parseResetTime(extra.head) },
			elapsedMs: Date.now() - startedAt,
			checkedAt
		});
		let response;
		try {
			response = await fetch(`${chatBase(credential.region)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body,
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
			});
		} catch (error) {
			return finish("error", { head: `transport error: ${String(error)}` });
		}
		if (!response.ok) {
			const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
			const code = parseBusinessCode(text);
			return finish(probeVerdictFor(response.status, code), {
				code,
				head: text
			});
		}
		let head = "";
		try {
			const reader = response.body?.getReader();
			if (reader === void 0) return finish("ok");
			const { value } = await reader.read();
			head = Buffer.from(value ?? []).toString("utf8");
			await reader.cancel().catch(() => {});
		} catch {
			return finish("ok");
		}
		const code = parseBusinessCode(head);
		if (code !== void 0 && PROBE_BLOCK_CODES.includes(code)) return finish(probeVerdictFor(response.status, code), {
			code,
			head
		});
		return finish("ok");
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
					if (Array.isArray(cfg["models"]) && cfg["models"].length > 0) return parseCatalogModels(cfg["models"], region);
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
					"User-Agent": clientUserAgent(region)
				},
				signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
			});
			if (res.ok) {
				const env = await readEnvelope(res);
				if (env.code === 0 && typeof env.data === "object" && env.data !== null) {
					const data = env.data;
					if (Array.isArray(data["models"])) return parseCatalogModels(data["models"], region);
				}
			}
		}
		throw new Error(`Failed to fetch models for ${region}`);
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
const WORKBUDDY_DUAL_VERSION = "0.1.5";
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
export { defaultDesktopCandidatesFor as _, WORKBUDDY_DUAL_VERSION as a, poolDocumentPath as b, FALLBACK_CN_MODELS as c, advertisedModelIds as d, defaultSelection as f, WorkBuddyDualCredentialStore as g, normalizeSelection as h, writeHostHeartbeat as i, FALLBACK_GLOBAL_MODELS as l, normalizeLanePreference as m, isHeartbeatProcessAlive as n, WorkBuddyUpstreamClient as o, filterModels as p, readHostHeartbeat as r, WorkBuddyDualSelectionStore as s, clearHostHeartbeat as t, WorkBuddyDualCatalog as u, parseWorkBuddyAuth as v, toCredential as x, WorkBuddyAccountPool as y };
