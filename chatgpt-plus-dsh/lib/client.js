// chatgpt-plus-dsh — browser half: the settings page shown in DSH → Plugins → ChatGPT Plus.
//
// Format: a classic script in the factory form used by every DSH client bundle. Executing it
// only registers the factory with window.__ModuleLoader__; DSH materializes it when the
// plugin row loads. `require` resolves DSH's platform seed modules (react and
// @deepseek-ai/dsh-client-ui-primitives); no other dependency is used, and no build step is
// needed. The page talks to the host half through same-origin JSON endpoints under
// /_dsh/chatgpt-plus-dsh, authenticated by DSH's browser-session cookie.
window.__ModuleLoader__.load({
	id: "chatgpt-plus-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var PACKAGE_NAME = "chatgpt-plus-dsh";
		var PREFIX = "/_dsh/chatgpt-plus-dsh";
		var STYLE_ID = "chatgpt-plus-dsh-page";
		var React = require("react");
		var primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = null;
		}
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useCallback = React.useCallback;

		// Only pass components that exist: createElement(undefined) would crash the page.
		function pick(name) {
			var value = primitives && primitives[name];
			return typeof value === "function" || (value && typeof value === "object" && value.$$typeof) ? value : null;
		}
		var NativeButton = pick("Button");
		var NativeSwitch = pick("Switch");
		var NativeCheckbox = pick("Checkbox");
		var NativeTag = pick("Tag");
		var NativeStateDot = pick("StateDot");

		// ---- helpers -------------------------------------------------------------

		function rpc(path, options) {
			var opts = options || {};
			var controller = typeof AbortController === "function" ? new AbortController() : null;
			var timer = setTimeout(function () { if (controller) controller.abort(); }, opts.timeoutMs || 30000);
			var init = {
				method: opts.method || "GET",
				credentials: "same-origin",
				cache: "no-store",
				headers: { accept: "application/json" },
				signal: controller ? controller.signal : undefined
			};
			if (opts.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(opts.body);
			}
			return fetch(PREFIX + path, init).then(function (res) {
				return res.json().catch(function () { return null; }).then(function (json) {
					if (!res.ok || !json || json.ok !== true) {
						var error = new Error((json && json.error && json.error.message) || ("Request failed (HTTP " + res.status + ")"));
						error.code = json && json.error && json.error.code;
						throw error;
					}
					return json.data;
				});
			}, function (error) {
				throw new Error(error && error.name === "AbortError" ? "The request timed out." : "Could not reach the DSH host. Is DeepSeek Harness still running?");
			}).finally(function () { clearTimeout(timer); });
		}

		function duration(ms) {
			if (!isFinite(ms)) return "";
			var total = Math.max(0, Math.round(ms / 1000));
			var d = Math.floor(total / 86400), hr = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60);
			if (d > 0) return hr > 0 ? d + "d " + hr + "h" : d + "d";
			if (hr > 0) return m > 0 ? hr + "h " + m + "m" : hr + "h";
			if (m > 0) return m + "m";
			return total + "s";
		}
		function relative(ts, now) {
			if (!ts) return "";
			var diff = ts - now;
			return diff >= 0 ? "in " + duration(diff) : duration(-diff) + " ago";
		}
		function absolute(ts) {
			try { return new Date(ts).toLocaleString(); } catch (error) { return ""; }
		}
		function windowName(minutes) {
			if (!minutes) return "Usage window";
			if (minutes % 10080 === 0) return minutes === 10080 ? "Weekly limit" : (minutes / 10080) + "-week limit";
			if (minutes % 1440 === 0) return minutes === 1440 ? "Daily limit" : (minutes / 1440) + "-day limit";
			if (minutes % 60 === 0) return (minutes / 60) + "-hour limit";
			return minutes + "-minute limit";
		}

		var STATUS_TEXT = {
			"connected": "Connected",
			"signing-in": "Signing in…",
			"expired": "Sign-in expired",
			"error": "Error",
			"signed-out": "Not signed in"
		};
		var STATUS_TONE = { "connected": "success", "signing-in": "info", "expired": "warning", "error": "danger", "signed-out": "neutral" };
		var STATUS_DOT = { "connected": "done", "signing-in": "ongoing", "expired": "warning", "error": "error", "signed-out": "idle" };

		// ---- styles (DSH design tokens, so light/dark themes follow the host) ----

		function installStyles() {
			if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return function () {};
			var style = document.createElement("style");
			style.setAttribute("data-plugin", PACKAGE_NAME);
			style.setAttribute("data-plugin-css", STYLE_ID);
			style.textContent = [
				".cgp-page{display:flex;flex-direction:column;gap:28px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px}",
				".cgp-page *{box-sizing:border-box}",
				".cgp-section{display:flex;flex-direction:column;gap:8px;min-width:0}",
				".cgp-heading{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
				".cgp-list{display:flex;flex-direction:column}",
				".cgp-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:12px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}",
				".cgp-row:last-child{border-bottom:0}",
				".cgp-text{display:flex;flex-direction:column;gap:2px;flex:1 1 240px;min-width:0}",
				".cgp-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:500;line-height:20px}",
				".cgp-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
				".cgp-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}",
				".cgp-btn{appearance:none;font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;font-size:12px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary)}",
				".cgp-btn:disabled{opacity:.45;cursor:not-allowed}",
				".cgp-btn--primary{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:#fff}",
				".cgp-danger{color:var(--dsw-alias-state-error-primary,#d92d20)!important}",
				".cgp-select,.cgp-input{height:30px;min-width:0;padding:0 10px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,transparent);border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.35));border-radius:var(--dsw-radius-md,10px)}",
				".cgp-input{flex:1 1 320px}",
				".cgp-select:focus-visible,.cgp-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
				".cgp-alert{margin:0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary,#d92d20);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 8%,transparent)}",
				".cgp-note{margin:0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 8%,transparent)}",
				".cgp-link{color:var(--dsw-alias-state-business-primary,#4d6bfe);text-decoration:underline;word-break:break-all}",
				".cgp-models{display:flex;flex-direction:column;gap:6px;padding:4px 2px 0}",
				".cgp-bar{position:relative;width:180px;height:6px;border-radius:999px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.2));overflow:hidden}",
				".cgp-bar>span{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4d6bfe)}",
				".cgp-bar--high>span{background:var(--dsw-alias-state-error-primary,#d92d20)}",
				".cgp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}",
				".cgp-tag{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;background:color-mix(in srgb,currentColor 10%,transparent)}",
				".cgp-summary{color:var(--dsw-alias-label-secondary)}"
			].join("\n");
			document.head.appendChild(style);
			return function () { if (style.parentNode) style.parentNode.removeChild(style); };
		}

		// ---- small components (host primitives when present, native fallbacks) ----

		function Btn(props) {
			var cls = props.danger ? "cgp-danger" : undefined;
			if (NativeButton) {
				return h(NativeButton, { variant: props.primary ? "primary" : "outline", size: "sm", disabled: !!props.disabled, onClick: props.onClick, className: cls, title: props.title, type: "button" }, props.children);
			}
			return h("button", { type: "button", className: "cgp-btn" + (props.primary ? " cgp-btn--primary" : "") + (cls ? " " + cls : ""), disabled: !!props.disabled, onClick: props.onClick, title: props.title }, props.children);
		}

		function Toggle(props) {
			if (NativeSwitch) return h(NativeSwitch, { checked: !!props.checked, onChange: props.onChange, label: props.label, disabled: !!props.disabled });
			return h("input", { type: "checkbox", role: "switch", "aria-label": props.label, checked: !!props.checked, disabled: !!props.disabled, onChange: function (e) { props.onChange(e.target.checked); } });
		}

		function Check(props) {
			if (NativeCheckbox) return h(NativeCheckbox, { checked: !!props.checked, onChange: props.onChange, label: props.label, disabled: !!props.disabled });
			return h("label", { style: { display: "inline-flex", gap: "8px", alignItems: "center" } },
				h("input", { type: "checkbox", checked: !!props.checked, disabled: !!props.disabled, onChange: function (e) { props.onChange(e.target.checked); } }),
				props.label);
		}

		function StatusTag(props) {
			var status = props.status;
			var text = STATUS_TEXT[status] || status;
			if (NativeTag) {
				return h(NativeTag, { tone: STATUS_TONE[status] || "neutral" },
					NativeStateDot ? h(NativeStateDot, { state: STATUS_DOT[status] || "idle" }) : null,
					text);
			}
			return h("span", { className: "cgp-tag" }, h("span", { className: "cgp-dot", "aria-hidden": "true" }), text);
		}

		function Row(props) {
			return h("div", { className: "cgp-row" },
				h("div", { className: "cgp-text" },
					h("div", { className: "cgp-title" }, props.title),
					props.description ? h("div", { className: "cgp-desc" }, props.description) : null),
				props.children ? h("div", { className: "cgp-controls" }, props.children) : null);
		}

		function UsageRow(props) {
			var w = props.window;
			if (!w) return null;
			var used = Math.round(w.usedPercent);
			var reset = w.resetsAt ? "resets " + relative(w.resetsAt, props.now) + " (" + absolute(w.resetsAt) + ")" : "";
			return h(Row, { title: windowName(w.windowMinutes), description: used + "% used" + (reset ? " · " + reset : "") },
				h("div", { className: "cgp-bar" + (used >= 90 ? " cgp-bar--high" : ""), role: "progressbar", "aria-valuenow": used, "aria-valuemin": 0, "aria-valuemax": 100 },
					h("span", { style: { width: Math.min(100, Math.max(0, used)) + "%" } })));
		}

		// ---- the page --------------------------------------------------------------

		function ChatGptPlusPage() {
			var _data = useState(null), data = _data[0], setData = _data[1];
			var _err = useState(""), loadError = _err[0], setLoadError = _err[1];
			var _busy = useState(""), busy = _busy[0], setBusy = _busy[1];
			var _actionError = useState(""), actionError = _actionError[0], setActionError = _actionError[1];
			var _paste = useState(""), paste = _paste[0], setPaste = _paste[1];
			var _model = useState(""), model = _model[0], setModel = _model[1];
			var _effort = useState(""), effort = _effort[0], setEffort = _effort[1];
			var _confirm = useState(false), confirmSignOut = _confirm[0], setConfirmSignOut = _confirm[1];
			var _notice = useState(""), notice = _notice[0], setNotice = _notice[1];
			var mounted = useRef(true);
			var usageRequested = useRef(false);

			var load = useCallback(function () {
				return rpc("/status").then(function (next) {
					if (!mounted.current) return;
					setData(next);
					setLoadError("");
				}, function (error) {
					if (mounted.current) setLoadError(error.message);
				});
			}, []);

			useEffect(function () {
				mounted.current = true;
				load();
				return function () { mounted.current = false; };
			}, [load]);

			// Poll quickly while a sign-in is pending, slowly otherwise; pause in hidden tabs.
			var status = data ? data.status : "";
			useEffect(function () {
				var delay = status === "signing-in" ? 1500 : 20000;
				var id = setInterval(function () {
					if (typeof document !== "undefined" && document.hidden) return;
					load();
				}, delay);
				return function () { clearInterval(id); };
			}, [status, load]);

			// Quota: fetched once per page view when connected.
			useEffect(function () {
				if (status === "connected" && !usageRequested.current) {
					usageRequested.current = true;
					rpc("/usage").then(function (next) { if (mounted.current) setData(next); }, function () {});
				}
				if (status !== "connected") usageRequested.current = false;
			}, [status]);

			// Model selector defaults: DSH's current default if it is ours, else the first visible model.
			useEffect(function () {
				if (!data || !data.models) return;
				var items = data.models.items || [];
				var known = items.some(function (m) { return m.id === model; });
				if (model && known) return;
				var current = data.defaultModel && data.defaultModel.provider === data.provider.id ? data.defaultModel.model : "";
				var first = items.filter(function (m) { return m.visible; })[0] || items[0];
				var nextModel = items.some(function (m) { return m.id === current; }) ? current : (first ? first.id : "");
				setModel(nextModel);
				var entry = items.filter(function (m) { return m.id === nextModel; })[0];
				var currentEffort = data.defaultModel && data.defaultModel.provider === data.provider.id ? data.defaultModel.reasoningEffort : "";
				setEffort(entry && entry.efforts.some(function (e) { return e.id === currentEffort; }) ? currentEffort : (entry && entry.defaultEffort) || "");
			}, [data, model]);

			function run(name, path, body, after) {
				setBusy(name);
				setActionError("");
				setNotice("");
				return rpc(path, { method: "POST", body: body || {} }).then(function (next) {
					if (!mounted.current) return;
					if (next && next.status) setData(next);
					if (after) after(next);
				}, function (error) {
					if (mounted.current) setActionError(error.message);
				}).finally(function () {
					if (mounted.current) setBusy("");
				});
			}

			if (!data) {
				return h("div", { className: "cgp-page" },
					loadError ? h("p", { className: "cgp-alert", role: "alert" }, loadError) : h("p", { className: "cgp-desc" }, "Loading…"));
			}

			var now = data.now || Date.now();
			var account = data.account;
			var signIn = data.signIn;
			var signedIn = !!account;
			var connected = status === "connected";
			var items = (data.models && data.models.items) || [];
			var selected = items.filter(function (m) { return m.id === model; })[0];

			// -- account section
			var accountRows = [];
			var accountDescription = signedIn
				? [account.email, account.plan ? "ChatGPT " + account.plan : null,
					account.expiresAt ? (account.expiresAt > now ? "access token expires " : "access token expired ") + relative(account.expiresAt, now) : null]
					.filter(Boolean).join(" · ")
				: "Sign in with your ChatGPT Plus or Pro account to use ChatGPT models on your subscription. No API key is needed.";
			var accountControls = [];
			if (status === "signing-in") {
				accountControls.push(h(Btn, { key: "cancel", onClick: function () { run("cancel", "/signin/cancel"); }, disabled: !!busy }, "Cancel"));
			} else if (!signedIn) {
				accountControls.push(h(Btn, { key: "signin", primary: true, onClick: function () { run("signin", "/signin", { openBrowser: true }); }, disabled: !!busy }, busy === "signin" ? "Opening browser…" : "Sign in with ChatGPT"));
			} else {
				accountControls.push(h(Btn, { key: "again", primary: status === "expired" || status === "error", onClick: function () { run("signin", "/signin", { openBrowser: true, restart: true }); }, disabled: !!busy }, "Sign in again"));
				if (confirmSignOut) {
					accountControls.push(h(Btn, { key: "confirm", danger: true, onClick: function () { setConfirmSignOut(false); run("signout", "/signout", {}, function (next) { if (next && next.restoredDefault) setNotice("Signed out. The DSH default model was restored to " + next.restoredDefault.provider + " / " + next.restoredDefault.model + "."); }); }, disabled: !!busy }, "Confirm sign out"));
					accountControls.push(h(Btn, { key: "keep", onClick: function () { setConfirmSignOut(false); } }, "Keep"));
				} else {
					accountControls.push(h(Btn, { key: "signout", danger: true, onClick: function () { setConfirmSignOut(true); }, disabled: !!busy }, "Sign out"));
				}
			}
			accountRows.push(h(Row, { key: "status", title: h(React.Fragment, null, "ChatGPT account", h(StatusTag, { status: status })), description: accountDescription }, accountControls));

			if (signIn) {
				var waiting = signIn.phase === "exchanging" ? "Finishing sign-in…" : "Approve the sign-in in your browser. This page updates automatically.";
				accountRows.push(h(Row, {
					key: "pending",
					title: waiting,
					description: h(React.Fragment, null,
						signIn.browserOpened === false ? "The browser could not be opened automatically. " : "If no browser tab opened, ",
						"use this link: ",
						signIn.authUrl ? h("a", { className: "cgp-link", href: signIn.authUrl, target: "_blank", rel: "noopener noreferrer" }, "Open the ChatGPT sign-in page") : null,
						signIn.expiresAt ? " · expires " + relative(signIn.expiresAt, now) : null)
				}));
				accountRows.push(h("div", { key: "paste", className: "cgp-row" },
					h("div", { className: "cgp-text" },
						h("div", { className: "cgp-title" }, signIn.portBusy || !signIn.callbackListening ? "Paste the redirect address" : "Browser did not return to DSH?"),
						h("div", { className: "cgp-desc" }, (signIn.callbackError ? signIn.callbackError + " " : "") +
							"After approving, copy the full address from the browser's address bar (it starts with " + (signIn.redirectUri || "http://localhost:1455/auth/callback") + "?code=) and paste it here.")),
					h("div", { className: "cgp-controls", style: { flex: "1 1 100%" } },
						h("input", { className: "cgp-input", type: "text", value: paste, placeholder: (signIn.redirectUri || "http://localhost:1455/auth/callback") + "?code=…&state=…", spellCheck: false, autoComplete: "off", onChange: function (e) { setPaste(e.target.value); }, "aria-label": "Redirect address" }),
						h(Btn, { onClick: function () { run("complete", "/signin/complete", { input: paste }, function () { setPaste(""); }); }, disabled: !!busy || !paste.trim() }, busy === "complete" ? "Signing in…" : "Complete sign-in"))));
			}

			// -- token section
			var tokenRows = signedIn ? [
				h(Row, {
					key: "auto",
					title: "Refresh tokens automatically",
					description: data.preferences.autoRefresh
						? "The access token is renewed in the background before it expires" + (account.refreshedAt ? " · last renewed " + relative(account.refreshedAt, now) : "") + "."
						: "Off: requests fail once the access token expires until you refresh it manually."
				}, h(Toggle, { label: "Refresh tokens automatically", checked: data.preferences.autoRefresh, disabled: !!busy, onChange: function (next) { run("prefs", "/preferences", { autoRefresh: next }); } })),
				h(Row, { key: "refresh", title: "Access token", description: account.expiresAt ? "Valid until " + absolute(account.expiresAt) + "." : "" },
					h(Btn, { onClick: function () { run("refresh", "/refresh", {}, function () { setNotice("Access token refreshed."); }); }, disabled: !!busy }, busy === "refresh" ? "Refreshing…" : "Refresh token now"))
			] : [];

			// -- models section
			var modelRows = [];
			if (signedIn) {
				var defaultModel = data.defaultModel;
				var defaultText = defaultModel ? (defaultModel.provider === data.provider.id ? data.provider.name : defaultModel.provider) + " / " + defaultModel.model + (defaultModel.reasoningEffort ? " (" + defaultModel.reasoningEffort + ")" : "") : "not available in this profile";
				var efforts = selected ? selected.efforts : [];
				modelRows.push(h(Row, { key: "default", title: "Default model", description: "Current DSH default: " + defaultText + ". Models are also selectable per session in the model picker under “" + data.provider.name + "”." },
					h("select", { className: "cgp-select", value: model, "aria-label": "Model", onChange: function (e) {
						var id = e.target.value;
						setModel(id);
						var entry = items.filter(function (m) { return m.id === id; })[0];
						setEffort(entry && entry.defaultEffort ? entry.defaultEffort : "");
					} }, items.map(function (m) { return h("option", { key: m.id, value: m.id }, m.name + (m.visible ? "" : " (hidden)")); })),
					efforts.length ? h("select", { className: "cgp-select", value: effort, "aria-label": "Reasoning effort", onChange: function (e) { setEffort(e.target.value); } },
						efforts.map(function (e2) { return h("option", { key: e2.id, value: e2.id }, e2.name); })) : null,
					h(Btn, { primary: true, disabled: !!busy || !model || !connected, onClick: function () { run("default", "/default-model", { model: model, reasoningEffort: effort || undefined }, function () { setNotice("DSH will use " + (selected ? selected.name : model) + " for new sessions."); }); } }, "Use as DSH default")));
				modelRows.push(h("div", { key: "visible", className: "cgp-row" },
					h("div", { className: "cgp-text" },
						h("div", { className: "cgp-title" }, "Show in the model picker"),
						h("div", { className: "cgp-desc" }, (data.models.source === "account" ? "Models available to this ChatGPT account" + (data.models.fetchedAt ? ", updated " + relative(data.models.fetchedAt, now) : "") : "Built-in model list (the account's list has not loaded yet)") + "."),
						h("div", { className: "cgp-models" }, items.map(function (m) {
							var label = m.name + (m.contextWindow ? " · " + Math.round(m.contextWindow / 1000) + "k context" : "") + (m.hiddenByDefault ? " · hidden by default" : "");
							return h(Check, { key: m.id, label: label, checked: m.visible, disabled: !!busy, onChange: function (next) { var patch = {}; patch[m.id] = next; run("prefs", "/preferences", { modelVisibility: patch }); } });
						}))),
					h("div", { className: "cgp-controls" },
						h(Btn, { onClick: function () { run("models", "/models/refresh"); }, disabled: !!busy || !connected }, busy === "models" ? "Loading…" : "Reload list"))));
				if (data.models.error) modelRows.push(h("p", { key: "models-error", className: "cgp-desc" }, data.models.error));
			}

			// -- usage section
			var usageRows = [];
			var usage = data.usage;
			if (signedIn && usage) {
				var primaryRow = h(UsageRow, { key: "primary", window: usage.primary, now: now });
				var secondaryRow = h(UsageRow, { key: "secondary", window: usage.secondary, now: now });
				if (usage.primary) usageRows.push(primaryRow);
				if (usage.secondary) usageRows.push(secondaryRow);
				var creditText = usage.credits ? (usage.credits.unlimited ? "Unlimited credits" : usage.credits.hasCredits ? "Credits: " + (usage.credits.balance || "available") : "No extra credits") : "";
				usageRows.push(h(Row, {
					key: "plan",
					title: usage.plan ? "ChatGPT " + usage.plan : "Subscription usage",
					description: [usage.limitReached ? "Usage limit reached" : null, creditText || null,
						usage.fetchedAt ? "checked " + relative(usage.fetchedAt, now) : (usage.updatedAt ? "updated " + relative(usage.updatedAt, now) : null),
						usage.error || null].filter(Boolean).join(" · ") || "Usage information appears after the first request or a refresh."
				}, h(Btn, { onClick: function () { run("usage", "/usage/refresh"); }, disabled: !!busy || !connected }, busy === "usage" ? "Checking…" : "Refresh usage")));
			}

			var alerts = [];
			if (loadError) alerts.push(h("p", { key: "load", className: "cgp-alert", role: "alert" }, loadError));
			if (actionError) alerts.push(h("p", { key: "action", className: "cgp-alert", role: "alert" }, actionError));
			if (data.error && data.error.message && data.error.message !== actionError) alerts.push(h("p", { key: "state", className: "cgp-alert", role: "alert" }, data.error.message));
			if (notice) alerts.push(h("p", { key: "notice", className: "cgp-note", role: "status" }, notice));

			function section(key, title, rows) {
				if (!rows.length) return null;
				return h("section", { key: key, className: "cgp-section" }, h("h3", { className: "cgp-heading" }, title), h("div", { className: "cgp-list" }, rows));
			}

			return h("div", { className: "cgp-page" },
				alerts.length ? h("div", { className: "cgp-section" }, alerts) : null,
				section("account", "Account", accountRows),
				section("token", "Token", tokenRows),
				section("models", "Models", modelRows),
				section("usage", "Usage", usageRows));
		}

		function BundleConfig(props) {
			if (props && props.view === "summary") {
				return h("span", { className: "cgp-summary" }, "Use ChatGPT models with your ChatGPT Plus/Pro subscription.");
			}
			return h(ChatGptPlusPage, null);
		}

		var inject = ["slots"];
		function apply(ctx) {
			ctx.effect(function () { return installStyles(); }, "chatgpt-plus-dsh: styles");
			// The plugin manager renders keyed `plugins.bundle.config` entries by package name.
			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: PACKAGE_NAME,
					label: function () { return "ChatGPT Plus"; }
				}, BundleConfig);
			});
		}

		exports.BundleConfig = BundleConfig;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
