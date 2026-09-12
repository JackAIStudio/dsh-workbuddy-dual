window.__ModuleLoader__.load({
	id: "dsh-workbuddy-dual",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		const WORKBUDDY_DUAL_STATUS_PATH = "/plugins/dsh-workbuddy-dual/status";
		//#endregion
		//#region src/client/DualPluginCard.tsx
		function dotStyle(status) {
			return {
				display: "inline-block",
				width: 8,
				height: 8,
				borderRadius: "50%",
				backgroundColor: status === "signed-in" ? "#22c55e" : status === "error" ? "#ef4444" : "#9ca3af",
				marginRight: 6
			};
		}
		function RegionCard({ title, data, t }) {
			const isSignIn = data && data.status === "signed-in";
			const status = data ? data.status : "signed-out";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					flex: "1 1 240px",
					padding: "12px 14px",
					borderRadius: 8,
					border: "1px solid var(--border-color, #e5e7eb)",
					background: "var(--card-bg, rgba(255, 255, 255, 0.03))"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontWeight: 600,
							fontSize: 13
						},
						children: title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							fontSize: 12,
							display: "flex",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: dotStyle(status) }), isSignIn ? t("signedInAs", { nickname: data.nickname ?? "OK" }) : t("signedOut")]
					})]
				}), isSignIn && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						fontSize: 12,
						color: "var(--text-secondary, #6b7280)",
						lineHeight: 1.6
					},
					children: [
						data.credits && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("creditsTotal", { total: data.credits.total }) }),
						data.creditsError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { color: "#ef4444" },
							children: data.creditsError
						}),
						data.expiresAt && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("accessTokenExpires", { time: new Date(data.expiresAt).toLocaleDateString() }) }),
						data.models && data.models.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								marginTop: 6,
								display: "flex",
								flexWrap: "wrap",
								gap: 4
							},
							children: data.models.slice(0, 4).map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 10,
									padding: "2px 6px",
									borderRadius: 4,
									background: m.free ? "rgba(34, 197, 94, 0.15)" : "rgba(156, 163, 175, 0.15)",
									color: m.free ? "#22c55e" : "inherit"
								},
								children: [
									m.name,
									" ",
									m.free ? `(${t("freeModel")})` : m.credits ? `(${m.credits})` : ""
								]
							}, m.id))
						})
					]
				})]
			});
		}
		function WorkBuddyDualCard({ t }) {
			if (!t) return null;
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [expanded, setExpanded] = (0, react.useState)(true);
			const mounted = (0, react.useRef)(true);
			const fetchStatus = async () => {
				setLoading(true);
				try {
					const res = await fetch(WORKBUDDY_DUAL_STATUS_PATH, { credentials: "same-origin" });
					if (res.ok && mounted.current) setStatus(await res.json());
				} catch {}
				if (mounted.current) setLoading(false);
			};
			(0, react.useEffect)(() => {
				mounted.current = true;
				fetchStatus();
				return () => {
					mounted.current = false;
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "16px",
					borderRadius: 10,
					border: "1px solid var(--border-color, #e5e7eb)",
					background: "var(--bg-panel, #ffffff)",
					marginBottom: 16
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 600,
							fontSize: 14
						},
						children: t("title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: "var(--text-secondary, #6b7280)",
							marginTop: 2
						},
						children: t("intro")
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => void fetchStatus(),
							disabled: loading,
							style: {
								fontSize: 12,
								padding: "4px 8px",
								borderRadius: 6,
								cursor: "pointer",
								border: "1px solid var(--border-color, #d1d5db)",
								background: "transparent"
							},
							children: loading ? t("refreshing") : t("refresh")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => setExpanded((v) => !v),
							style: {
								fontSize: 12,
								padding: "4px 8px",
								borderRadius: 6,
								cursor: "pointer",
								border: "1px solid var(--border-color, #d1d5db)",
								background: "transparent"
							},
							children: expanded ? t("collapse") : t("expand")
						})]
					})]
				}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						marginTop: 14,
						display: "flex",
						flexWrap: "wrap",
						gap: 12
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RegionCard, {
						title: t("cnSection"),
						data: status?.cn,
						t
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RegionCard, {
						title: t("globalSection"),
						data: status?.global,
						t
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		const en = {
			title: "DSH WorkBuddy Dual",
			intro: "Simultaneously connect WorkBuddy CN and Global models into DeepSeek Harness — dual-track, zero configuration.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading accounts…",
			cnSection: "🇨🇳 WorkBuddy CN",
			globalSection: "🌍 WorkBuddy Global",
			signedOut: "Not signed in",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Expires {time}",
			creditsTotal: "Credits: {total}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			requestFailed: "Request failed",
			freeModel: "Free"
		};
		const zh = {
			title: "DSH WorkBuddy Dual (双轨版)",
			intro: "同时接入 WorkBuddy 国内版与海外版模型，双轨并发、免配置使用。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取双端账号…",
			cnSection: "🇨🇳 WorkBuddy 国内版",
			globalSection: "🌍 WorkBuddy 海外版",
			signedOut: "未登录",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "到期时间：{time}",
			creditsTotal: "剩余积分：{total}",
			refresh: "刷新状态",
			refreshing: "正在刷新…",
			requestFailed: "请求失败",
			freeModel: "免费"
		};
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-workbuddy-dual-client";
		const inject = ["slots", "locale"];
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-dual";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-dual: settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy-dual",
					priority: 35,
					inject: () => ({ t })
				}, WorkBuddyDualCard));
			} catch (error) {
				console.error("[dsh-workbuddy-dual] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
