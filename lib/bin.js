#!/usr/bin/env node
import { a as WORKBUDDY_DUAL_VERSION, c as FALLBACK_GLOBAL_MODELS, n as isHeartbeatProcessAlive, o as WorkBuddyUpstreamClient, r as readHostHeartbeat, s as FALLBACK_CN_MODELS, u as WorkBuddyDualCredentialStore } from "./host-heartbeat-BAnCJmKd.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for dsh-workbuddy-dual. */
const JSON_SCHEMA_VERSION = 1;
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-dual <doctor|status|logout> [--json]",
		"",
		"  doctor   secret-free sign-in and dual environment diagnostics (CN & Global)",
		"  status   sign-in state, remaining credits for both CN and Global, and host health",
		"  logout   remove plugin-owned credential copies (desktop apps keep sign-in)",
		"  --json   emit one secret-free JSON document",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function makeStore() {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyDualCredentialStore({
		refreshCN: (cred) => client.refreshToken(cred),
		refreshGlobal: (cred) => client.refreshToken(cred)
	});
}
async function doctor(jsonOutput) {
	const store = makeStore();
	const cnStatus = await store.cn.status();
	const globalStatus = await store.global.status();
	const cnDesktopPresent = await store.cn.desktopFilePresent();
	const globalDesktopPresent = await store.global.desktopFilePresent();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-dual",
		version: WORKBUDDY_DUAL_VERSION,
		node: process.version,
		cn: {
			signIn: cnStatus.state,
			desktopAuthFilePresent: cnDesktopPresent,
			candidates: store.cn.resolveDesktopCandidates(),
			fallbackModels: FALLBACK_CN_MODELS.length
		},
		global: {
			signIn: globalStatus.state,
			desktopAuthFilePresent: globalDesktopPresent,
			candidates: store.global.resolveDesktopCandidates(),
			fallbackModels: FALLBACK_GLOBAL_MODELS.length
		},
		hostBundle: {
			running: hostAlive,
			pid: heartbeat?.pid
		}
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`WorkBuddy Dual ${WORKBUDDY_DUAL_VERSION} on ${process.version}`,
		"--- [CN / 国内版] ---",
		`  Sign-in state: ${cnStatus.state}`,
		`  Desktop auth file: ${cnDesktopPresent ? "present" : "missing"}`,
		`  Fallback models: ${FALLBACK_CN_MODELS.length}`,
		"--- [Global / 海外版] ---",
		`  Sign-in state: ${globalStatus.state}`,
		`  Desktop auth file: ${globalDesktopPresent ? "present" : "missing"}`,
		`  Fallback models: ${FALLBACK_GLOBAL_MODELS.length}`,
		"------------------------",
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat?.pid})` : "not started / idle"}`,
		""
	].join("\n"));
	return cnStatus.state === "signed-in" || globalStatus.state === "signed-in" ? 0 : 1;
}
async function status(jsonOutput) {
	const store = makeStore();
	const client = new WorkBuddyUpstreamClient();
	const cnStatus = await store.cn.status();
	const globalStatus = await store.global.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	let cnCredits;
	let globalCredits;
	if (cnStatus.state === "signed-in") try {
		const cred = await store.cn.current();
		if (cred) cnCredits = (await client.fetchCredits(cred)).totalBalance;
	} catch {}
	if (globalStatus.state === "signed-in") try {
		const cred = await store.global.current();
		if (cred) globalCredits = (await client.fetchCredits(cred)).totalBalance;
	} catch {}
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-dual",
			version: WORKBUDDY_DUAL_VERSION,
			hostAlive,
			cn: {
				status: cnStatus.state,
				nickname: cnStatus.state === "signed-in" ? cnStatus.nickname : void 0,
				credits: cnCredits
			},
			global: {
				status: globalStatus.state,
				nickname: globalStatus.state === "signed-in" ? globalStatus.nickname : void 0,
				credits: globalCredits
			}
		});
		return 0;
	}
	process.stdout.write([
		`WorkBuddy Dual ${WORKBUDDY_DUAL_VERSION}:`,
		`  🇨🇳 CN Account:     ${cnStatus.state === "signed-in" ? `${cnStatus.nickname ?? "signed-in"} (Credits: ${cnCredits ?? "unknown"})` : "signed-out"}`,
		`  🌍 Global Account: ${globalStatus.state === "signed-in" ? `${globalStatus.nickname ?? "signed-in"} (Credits: ${globalCredits ?? "unknown"})` : "signed-out"}`,
		`  Host bundle:       ${hostAlive ? `running (pid ${heartbeat?.pid})` : "not started"}`,
		""
	].join("\n"));
	return 0;
}
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	const jsonOutput = flags.includes("--json");
	switch (rawAction) {
		case "doctor": return await doctor(jsonOutput);
		case "status": return await status(jsonOutput);
		case "logout": {
			const store = makeStore();
			await store.cn.logout();
			await store.global.logout();
			process.stdout.write("WorkBuddy Dual: removed plugin credential caches; desktop apps untouched\n");
			return 0;
		}
		default:
			process.stderr.write(`dsh-workbuddy-dual: unknown action ${rawAction}\n`);
			return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
