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
		//#region src/model-paths.ts
		/** Wire vocabulary shared by the Host model routes and the browser card. */
		const WORKBUDDY_DUAL_MODELS_PATH = "/plugins/dsh-workbuddy-dual/models";
		//#endregion
		//#region src/client/ModelPicker.tsx
		const LANES = ["cn", "global"];
		/** Ids currently checked in a lane's staged draft. */
		function selectedIds(models) {
			return models.filter((model) => model.selected).map((model) => model.id);
		}
		function formatContext(contextWindow) {
			if (!Number.isFinite(contextWindow) || contextWindow <= 0) return "";
			if (contextWindow >= 1e6) return `${Math.round(contextWindow / 1e5) / 10}M`;
			return `${Math.round(contextWindow / 1e3)}K`;
		}
		async function readError(response) {
			try {
				const body = await response.json();
				if (typeof body.error === "string" && body.error !== "") return body.error;
			} catch {}
			return `HTTP ${response.status}`;
		}
		function LaneModelList({ lane, draft, onToggle, onSelectAll, onSelectNone, t }) {
			const [query, setQuery] = (0, react.useState)("");
			const needle = query.trim().toLowerCase();
			const visible = needle === "" ? draft : draft.filter((model) => model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle));
			const checkedCount = draft.filter((model) => model.selected).length;
			const allChecked = draft.length > 0 && checkedCount === draft.length;
			const someChecked = checkedCount > 0 && !allChecked;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 10
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 12
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 13,
								color: "var(--dsw-alias-label-secondary, #6b7280)"
							},
							children: t("selectedCount", {
								count: checkedCount,
								total: draft.length
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: onSelectAll,
								disabled: allChecked,
								style: miniButtonStyle,
								children: t("selectAll")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: onSelectNone,
								disabled: checkedCount === 0,
								style: miniButtonStyle,
								children: t("selectNone")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "search",
						value: query,
						onChange: (event) => setQuery(event.target.value),
						placeholder: t("searchModels"),
						"aria-label": t("searchModels"),
						style: {
							width: "100%",
							boxSizing: "border-box",
							padding: "7px 10px",
							borderRadius: 7,
							border: "1px solid var(--border-color, #e5e7eb)",
							background: "transparent",
							color: "inherit",
							fontSize: 13
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "group",
						"aria-label": lane === "cn" ? t("cnSection") : t("globalSection"),
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 2,
							maxHeight: 320,
							overflowY: "auto",
							paddingRight: 4
						},
						children: [visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "18px 4px",
								fontSize: 13,
								color: "var(--dsw-alias-label-secondary, #6b7280)"
							},
							children: draft.length === 0 ? t("noModels") : t("noMatches")
						}), visible.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 9,
								padding: "7px 6px",
								borderRadius: 6,
								cursor: "pointer",
								fontSize: 13
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: model.selected,
									onChange: () => onToggle(model.id),
									style: {
										margin: 0,
										flex: "none"
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: 1,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									},
									children: model.name
								}),
								model.free && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "#22c55e",
										flex: "none"
									},
									children: t("freeModel")
								}),
								model.credits && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary, #6b7280)",
										flex: "none"
									},
									children: model.credits
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary, #6b7280)",
										width: 42,
										textAlign: "right",
										flex: "none"
									},
									children: formatContext(model.contextWindow)
								})
							]
						}, model.id))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							fontSize: 13,
							cursor: "pointer",
							paddingTop: 2
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: allChecked,
							ref: (node) => {
								if (node !== null) node.indeterminate = someChecked;
							},
							onChange: (event) => event.target.checked ? onSelectAll() : onSelectNone(),
							style: { margin: 0 }
						}), t("selectAllHint")]
					})
				]
			});
		}
		function ModelPicker({ t }) {
			if (!t) return null;
			const [view, setView] = (0, react.useState)(null);
			const [drafts, setDrafts] = (0, react.useState)(null);
			const [baseline, setBaseline] = (0, react.useState)(null);
			const [enabled, setEnabled] = (0, react.useState)({
				cn: true,
				global: true
			});
			const [mode, setMode] = (0, react.useState)({
				cn: "all",
				global: "all"
			});
			const [loading, setLoading] = (0, react.useState)(true);
			const [saving, setSaving] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(void 0);
			const mounted = (0, react.useRef)(true);
			const hydrate = (next) => {
				setView(next);
				setDrafts({
					cn: [...next.cn.models],
					global: [...next.global.models]
				});
				setBaseline({
					cn: [...next.cn.models],
					global: [...next.global.models]
				});
				setEnabled({
					cn: next.cn.enabled,
					global: next.global.enabled
				});
				setMode({
					cn: next.cn.mode,
					global: next.global.mode
				});
			};
			const load = async () => {
				setLoading(true);
				try {
					const response = await fetch(WORKBUDDY_DUAL_MODELS_PATH, { credentials: "same-origin" });
					if (!response.ok) throw new Error(await readError(response));
					const next = await response.json();
					if (mounted.current) {
						hydrate(next);
						setNotice(void 0);
					}
				} catch (error) {
					if (mounted.current) setNotice({
						kind: "error",
						text: error instanceof Error && error.message === t("requestFailed") ? t("loadFailedHint") : t("loadFailed", { error: error instanceof Error ? error.message : String(error) })
					});
				} finally {
					if (mounted.current) setLoading(false);
				}
			};
			(0, react.useEffect)(() => {
				mounted.current = true;
				load();
				return () => {
					mounted.current = false;
				};
			}, []);
			const dirty = (0, react.useMemo)(() => {
				if (!view || !drafts || !baseline) return false;
				return LANES.some((lane) => {
					const stored = view[lane];
					if (stored.enabled !== enabled[lane] || stored.mode !== mode[lane]) return true;
					const now = new Set(selectedIds(drafts[lane]));
					const before = new Set(selectedIds(baseline[lane]));
					return now.size !== before.size || [...now].some((id) => !before.has(id));
				});
			}, [
				view,
				drafts,
				baseline,
				enabled,
				mode
			]);
			const updateDraft = (lane, change) => {
				setDrafts((current) => current === null ? current : {
					...current,
					[lane]: change(current[lane])
				});
				setNotice(void 0);
			};
			const markSelected = (lane, ids) => {
				const wanted = new Set(ids);
				updateDraft(lane, (models) => models.map((model) => ({
					...model,
					selected: wanted.has(model.id)
				})));
			};
			const save = async () => {
				if (!drafts) return;
				const payload = {};
				for (const lane of LANES) payload[lane] = {
					enabled: enabled[lane],
					mode: mode[lane],
					models: mode[lane] === "all" ? [] : selectedIds(drafts[lane])
				};
				setSaving(true);
				setNotice(void 0);
				try {
					const response = await fetch(WORKBUDDY_DUAL_MODELS_PATH, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					});
					if (!response.ok) throw new Error(await readError(response));
					const next = await response.json();
					if (mounted.current) {
						hydrate(next);
						setNotice({
							kind: "ok",
							text: t("saved")
						});
					}
				} catch (error) {
					if (mounted.current) setNotice({
						kind: "error",
						text: t("saveFailed", { error: String(error) })
					});
				} finally {
					if (mounted.current) setSaving(false);
				}
			};
			if (loading && view === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: 16,
					fontSize: 13,
					color: "var(--dsw-alias-label-secondary, #6b7280)"
				},
				children: t("loading")
			});
			if (view === null || drafts === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 16,
					fontSize: 13
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { marginBottom: 10 },
					children: notice?.text ?? t("loadFailedHint")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => void load(),
					style: miniButtonStyle,
					children: t("retry")
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: {
					border: "1px solid var(--border-color, #e5e7eb)",
					borderRadius: 10,
					padding: "16px 18px 18px",
					background: "var(--bg-panel, transparent)",
					display: "flex",
					flexDirection: "column",
					gap: 16
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: {
							display: "flex",
							alignItems: "flex-start",
							justifyContent: "space-between",
							gap: 16
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 15,
								fontWeight: 600,
								marginBottom: 3
							},
							children: t("pickerTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								lineHeight: "19px",
								color: "var(--dsw-alias-label-secondary, #6b7280)"
							},
							children: t("pickerIntro")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8,
								flex: "none"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => void load(),
								disabled: loading || saving,
								style: miniButtonStyle,
								children: loading ? t("refreshing") : t("refreshList")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => void save(),
								disabled: saving || !dirty,
								style: primaryButtonStyle(saving || !dirty),
								children: saving ? t("saving") : t("save")
							})]
						})]
					}),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						style: {
							fontSize: 13,
							padding: "8px 10px",
							borderRadius: 7,
							color: notice.kind === "ok" ? "#16a34a" : "#dc2626",
							background: notice.kind === "ok" ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.1)"
						},
						children: notice.text
					}),
					LANES.map((lane) => {
						const stored = view[lane];
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 12,
								paddingTop: lane === "global" ? 16 : 2,
								borderTop: lane === "global" ? "1px solid var(--border-color, #e5e7eb)" : "none"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 12,
									flexWrap: "wrap"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "baseline",
										gap: 8
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 14,
											fontWeight: 600
										},
										children: lane === "cn" ? t("cnSection") : t("globalSection")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary, #6b7280)"
										},
										children: !stored.signedIn ? t("signedOut") : stored.live ? t("liveCatalog") : t("fallbackCatalog")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 16,
										flexWrap: "wrap"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 7,
											fontSize: 13,
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: enabled[lane],
											onChange: (event) => {
												setEnabled((current) => ({
													...current,
													[lane]: event.target.checked
												}));
												setNotice(void 0);
											},
											style: { margin: 0 }
										}), t("laneEnabled")]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										role: "radio-group",
										"aria-label": t("modeLabel"),
										style: {
											display: "flex",
											border: "1px solid var(--border-color, #e5e7eb)",
											borderRadius: 7,
											overflow: "hidden"
										},
										children: ["all", "selected"].map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "radio",
											"aria-checked": mode[lane] === option,
											onClick: () => {
												setMode((current) => ({
													...current,
													[lane]: option
												}));
												setNotice(void 0);
											},
											style: {
												fontSize: 12,
												padding: "5px 10px",
												border: "none",
												cursor: "pointer",
												background: mode[lane] === option ? "var(--dsw-alias-interactive-bg-hover, #eef2ff)" : "transparent",
												color: "inherit",
												fontWeight: mode[lane] === option ? 600 : 400
											},
											children: option === "all" ? t("modeAll") : t("modeSelected")
										}, option))
									})]
								})]
							}), !enabled[lane] ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									color: "var(--dsw-alias-label-secondary, #6b7280)"
								},
								children: t("laneDisabledHint")
							}) : mode[lane] === "all" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									color: "var(--dsw-alias-label-secondary, #6b7280)"
								},
								children: t("modeAllHint", { total: drafts[lane].length })
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LaneModelList, {
								lane,
								draft: drafts[lane],
								onToggle: (id) => updateDraft(lane, (models) => models.map((model) => model.id === id ? {
									...model,
									selected: !model.selected
								} : model)),
								onSelectAll: () => markSelected(lane, drafts[lane].map((model) => model.id)),
								onSelectNone: () => markSelected(lane, []),
								t
							})]
						}, lane);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("footer", {
						style: {
							fontSize: 12,
							lineHeight: "18px",
							color: "var(--dsw-alias-label-secondary, #6b7280)"
						},
						children: t("pickerFoot")
					})
				]
			});
		}
		const miniButtonStyle = {
			fontSize: 12,
			padding: "5px 9px",
			borderRadius: 6,
			cursor: "pointer",
			border: "1px solid var(--border-color, #d1d5db)",
			background: "transparent",
			color: "inherit"
		};
		function primaryButtonStyle(disabled) {
			return {
				fontSize: 12,
				padding: "5px 12px",
				borderRadius: 6,
				cursor: disabled ? "not-allowed" : "pointer",
				border: "1px solid transparent",
				background: disabled ? "rgba(59, 130, 246, 0.25)" : "rgb(37, 99, 235)",
				color: "#ffffff"
			};
		}
		//#endregion
		//#region src/client/locales.ts
		const en = {
			nav: "WorkBuddy Dual",
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
			freeModel: "Free",
			pickerTitle: "Models to show",
			pickerIntro: "Pick the models you actually use. Everything you do not select stays out of the model picker, so the list stays short.",
			pickerFoot: "Switching a lane off hides that whole provider. Hiding a model never deletes it: switch back to “All models” any time.",
			laneEnabled: "Enable this lane",
			laneDisabledHint: "This lane is off, so none of its models appear in model pickers.",
			modeLabel: "Which models to show",
			modeAll: "All models",
			modeSelected: "Only selected",
			modeAllHint: "Showing all {total} models. Switch to “Only selected” to pick a short list.",
			selectedCount: "{count} of {total} selected",
			selectAll: "Select all",
			selectNone: "Clear",
			selectAllHint: "Select all models in this lane",
			searchModels: "Search models",
			noMatches: "No model matches this search.",
			noModels: "This lane has no models yet. Sign in to WorkBuddy and refresh.",
			liveCatalog: "live catalog",
			fallbackCatalog: "fallback catalog",
			save: "Save",
			saving: "Saving…",
			saved: "Saved. Model pickers now follow this list.",
			loadFailed: "Could not load models: {error}",
			saveFailed: "Could not save: {error}",
			retry: "Retry",
			loadFailedHint: "The plugin's model route did not answer. Reload the window and try again.",
			refreshList: "Reload list"
		};
		const zh = {
			nav: "WorkBuddy 双轨",
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
			freeModel: "免费",
			pickerTitle: "要显示哪些模型",
			pickerIntro: "只留下你真正会用的模型。没勾选的模型不会出现在模型选择器里，列表就不会被几十个名字撑满。",
			pickerFoot: "关掉某条轨，等于把那一端的模型全部隐藏；隐藏不会删除，随时切回“全部模型”就能找回。",
			laneEnabled: "启用这条轨",
			laneDisabledHint: "这条轨已关闭，它的模型不会出现在任何模型选择器里。",
			modeLabel: "显示范围",
			modeAll: "全部模型",
			modeSelected: "只显示勾选",
			modeAllHint: "当前显示全部 {total} 个模型。切到“只显示勾选”，挑一份自己的短名单。",
			selectedCount: "已选 {count} / {total}",
			selectAll: "全选",
			selectNone: "清空",
			selectAllHint: "选中这一端的全部模型",
			searchModels: "搜索模型",
			noMatches: "没有匹配这个搜索的模型。",
			noModels: "这一端还没有模型。请先登录 WorkBuddy 再刷新。",
			liveCatalog: "已读上游目录",
			fallbackCatalog: "内置目录",
			save: "保存",
			saving: "正在保存…",
			saved: "已保存，模型选择器已按这份清单更新。",
			loadFailed: "读取模型清单失败：{error}",
			saveFailed: "保存失败：{error}",
			retry: "重试",
			loadFailedHint: "插件的模型接口没有响应。请刷新窗口后再试一次。",
			refreshList: "刷新列表"
		};
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-workbuddy-dual-client";
		const inject = ["slots", "locale"];
		function WorkBuddySettingsSection({ t }) {
			if (!t) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 24,
					boxSizing: "border-box",
					width: "100%",
					padding: "32px 32px 48px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: {
							margin: "0 0 4px",
							fontSize: 20,
							fontWeight: 600,
							lineHeight: "28px",
							color: "var(--dsw-alias-label-primary, inherit)"
						},
						children: t("nav")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 14,
							lineHeight: "20px",
							color: "var(--dsw-alias-label-secondary, #6b7280)"
						},
						children: t("intro")
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkBuddyDualCard, { t }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, { t })
				]
			});
		}
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddy-dual";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-dual: settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "workbuddy-dual-section",
					order: 14,
					label: () => t("nav"),
					inject: () => ({ t })
				}, WorkBuddySettingsSection));
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
