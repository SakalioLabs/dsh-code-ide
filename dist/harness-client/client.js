window.__ModuleLoader__.load({
	id: "dsh-code-ide",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/harness-client/index.tsx
		var IDE_VIEW_ID = "dsh-code-ide";
		var IDE_VIEW_LABEL = "IDE";
		/**
		* Resolved Harness values copied into the same-origin IDE document. Keeping
		* the bridge allow-listed avoids mirroring arbitrary host or third-party CSS.
		*/
		var HARNESS_THEME_TOKENS = [
			"--dsw-font-family",
			"--ds-font-family-code",
			"--dsw-alias-bg-base",
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-bg-layer-3",
			"--dsw-alias-bg-mask-1",
			"--dsw-alias-bg-mask-3",
			"--dsw-alias-border-l1",
			"--dsw-alias-border-l2-darkmode-thin",
			"--dsw-alias-border-l2",
			"--dsw-alias-border-l3",
			"--dsw-alias-label-primary",
			"--dsw-alias-label-secondary",
			"--dsw-alias-label-tertiary",
			"--dsw-alias-label-caption",
			"--dsw-alias-interactive-bg-hover",
			"--dsw-alias-interactive-bg-hover-solid",
			"--dsw-alias-interactive-bg-active",
			"--dsw-alias-button-elevated-fill",
			"--dsw-alias-button-floating-fill",
			"--dsw-alias-button-primary-fill",
			"--dsw-alias-button-primary-hover",
			"--dsw-alias-state-business-primary",
			"--dsw-alias-state-business-tertiary",
			"--dsw-alias-state-error-primary",
			"--dsw-alias-state-success-primary",
			"--dsw-alias-state-warn-label",
			"--dsw-alias-state-warn-tertiary",
			"--dsw-specific-input-major",
			"--dsw-specific-menu",
			"--dsw-alias-scrollbar-bg-l1",
			"--dsw-alias-scrollbar-hover-l1"
		];
		function browserThemeWatchRuntime(source) {
			const view = source.defaultView;
			if (view === null || typeof view.requestAnimationFrame !== "function" || typeof view.cancelAnimationFrame !== "function") return void 0;
			return {
				createObserver: (callback) => new view.MutationObserver(callback),
				requestFrame: (callback) => view.requestAnimationFrame(callback),
				cancelFrame: (handle) => {
					view.cancelAnimationFrame(handle);
				}
			};
		}
		/**
		* Copy the host's resolved palette to one already-loaded same-origin frame.
		* A cross-origin navigation or torn-down frame is a supported no-op.
		*/
		function syncHarnessThemeToFrame(source, frame) {
			if (frame === null) return false;
			try {
				const target = frame.contentDocument;
				const sourceView = source.defaultView;
				if (target === null || sourceView === null) return false;
				const sourceStyle = sourceView.getComputedStyle(source.body);
				const targetStyle = target.documentElement.style;
				for (const token of HARNESS_THEME_TOKENS) {
					const value = sourceStyle.getPropertyValue(token).trim();
					if (value === "") targetStyle.removeProperty(token);
					else targetStyle.setProperty(token, value);
				}
				const dark = source.body.hasAttribute("data-ds-dark-theme");
				targetStyle.colorScheme = dark ? "dark" : "light";
				if (dark) target.body.setAttribute("data-ds-dark-theme", "");
				else target.body.removeAttribute("data-ds-dark-theme");
				return true;
			} catch {
				return false;
			}
		}
		/**
		* Watch only the attributes owned by Harness' ThemePresenter. Bursts of
		* token writes collapse into one animation-frame sync and cleanup is total.
		*/
		function watchHarnessTheme(source, onChange, providedRuntime) {
			const runtime = providedRuntime ?? browserThemeWatchRuntime(source);
			if (runtime === void 0) return () => {};
			let observer;
			let scheduledFrame;
			let disposed = false;
			const schedule = () => {
				if (disposed || scheduledFrame !== void 0) return;
				try {
					scheduledFrame = runtime.requestFrame(() => {
						scheduledFrame = void 0;
						if (disposed) return;
						try {
							onChange();
						} catch {}
					});
				} catch {
					scheduledFrame = void 0;
				}
			};
			try {
				observer = runtime.createObserver(schedule);
				observer.observe(source.body, {
					attributes: true,
					attributeFilter: ["style", "data-ds-dark-theme"]
				});
				observer.observe(source.documentElement, {
					attributes: true,
					attributeFilter: ["style"]
				});
			} catch {
				try {
					observer?.disconnect();
				} catch {}
				return () => {};
			}
			return () => {
				disposed = true;
				if (scheduledFrame !== void 0) {
					try {
						runtime.cancelFrame(scheduledFrame);
					} catch {}
					scheduledFrame = void 0;
				}
				try {
					observer?.disconnect();
				} catch {}
			};
		}
		var ROOT_STYLE = {
			display: "flex",
			flex: "1 1 0",
			boxSizing: "border-box",
			width: "100%",
			height: "100%",
			minWidth: 0,
			minHeight: 0,
			overflow: "hidden",
			background: "var(--dsw-alias-bg-base)"
		};
		var FRAME_STYLE = {
			display: "block",
			flex: "1 1 0",
			width: "100%",
			minWidth: 0,
			minHeight: 0,
			border: 0,
			background: "var(--dsw-alias-bg-base)",
			colorScheme: "light dark"
		};
		var STATUS_STYLE = {
			display: "grid",
			flex: "1 1 0",
			placeItems: "center",
			minWidth: 0,
			minHeight: 0,
			padding: 24,
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 13,
			textAlign: "center"
		};
		/** Resolve the Workspace account that owns a Harness session. */
		function workspaceIdForSession(workspaces, sessionId) {
			return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId;
		}
		var LOADING_TARGET = { kind: "loading" };
		var ERROR_TARGET = { kind: "error" };
		var UNATTACHED_TARGET = { kind: "unattached" };
		/** Distinguish a pending baseline from a ready-but-unaccounted Session. */
		function workspaceTargetForSession(snapshot, sessionId) {
			const workspaceId = workspaceIdForSession(snapshot.items, sessionId);
			if (workspaceId !== void 0) return {
				kind: "workspace",
				workspaceId
			};
			if (snapshot.state === "error") return ERROR_TARGET;
			return snapshot.phase === "pending" || !snapshot.baselinesReady ? LOADING_TARGET : UNATTACHED_TARGET;
		}
		function workspaceTargetsEqual(left, right) {
			return left.kind === "workspace" && right.kind === "workspace" ? left.workspaceId === right.workspaceId : left.kind === right.kind;
		}
		/** Build the same-origin companion URL without changing the Harness root route. */
		function ideFrameHref(workspaceId, locale = "en") {
			return `/dsh-code-ide/?embedded=1&workspaceId=${encodeURIComponent(workspaceId)}&locale=${locale}`;
		}
		function syncHarnessLocaleToFrame(frame, locale, targetOrigin = window.location.origin) {
			if (frame === null) return false;
			try {
				const target = frame.contentWindow;
				if (target === null) return false;
				target.postMessage({
					type: "dsh-code-ide/locale",
					locale
				}, targetOrigin);
				return true;
			} catch {
				return false;
			}
		}
		function HiddenIdeComposer(_props) {
			return null;
		}
		/**
		* Hide the ordinary composer only for the strict Session currently hosting
		* the mounted IDE view. Earlier question/approval takeovers keep winning the
		* chain; cleanup restores the normal fallback immediately.
		*/
		function registerIdeComposerSuppression(slots, sessionId) {
			return slots.inject("conversation.composer", () => slots.register({
				name: "conversation.composer",
				priority: Number.MAX_SAFE_INTEGER,
				select: (owner) => owner.session?.sessionId === sessionId ? true : null
			}, HiddenIdeComposer));
		}
		/** IDE body rendered only after the user selects the native IDE tab. */
		function HarnessIdeView({ sessionId, useWorkspaces, locale = "en" }) {
			const frame = (0, react.useRef)(null);
			const source = (0, react.useRef)();
			const target = useWorkspaces((snapshot) => workspaceTargetForSession(snapshot, sessionId), workspaceTargetsEqual);
			const workspaceId = target.kind === "workspace" ? target.workspaceId : void 0;
			if (workspaceId !== void 0 && source.current?.workspaceId !== workspaceId) source.current = {
				workspaceId,
				href: ideFrameHref(workspaceId, locale)
			};
			const syncTheme = (0, react.useCallback)(() => syncHarnessThemeToFrame(document, frame.current), []);
			const syncLocale = (0, react.useCallback)(() => syncHarnessLocaleToFrame(frame.current, locale), [locale]);
			const syncFrame = (0, react.useCallback)(() => {
				syncTheme();
				syncLocale();
			}, [syncLocale, syncTheme]);
			(0, react.useEffect)(() => {
				if (workspaceId === void 0) return;
				syncTheme();
				return watchHarnessTheme(document, syncTheme);
			}, [syncTheme, workspaceId]);
			(0, react.useEffect)(() => {
				if (workspaceId !== void 0) syncLocale();
			}, [syncLocale, workspaceId]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				"data-conversation-composer-overlay": "",
				style: ROOT_STYLE,
				children: workspaceId !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
					ref: frame,
					src: source.current?.href,
					title: locale === "zh" ? "IDE 代码浏览器" : "IDE code browser",
					style: FRAME_STYLE,
					allow: "clipboard-write",
					onLoad: syncFrame
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: target.kind === "error" ? "alert" : "status",
					"aria-live": "polite",
					style: STATUS_STYLE,
					children: target.kind === "loading" ? locale === "zh" ? "正在加载工作区…" : "Loading workspace…" : target.kind === "error" ? locale === "zh" ? "无法加载工作区。" : "Workspaces could not be loaded." : locale === "zh" ? "此会话尚未关联工作区。" : "This session is not attached to a workspace."
				})
			});
		}
		/** Bind the composer lifecycle to the native IDE view's mounted lifetime. */
		function bindHarnessIdeView(slots, locale) {
			return function BoundHarnessIdeView(props) {
				const subscribe = (0, react.useCallback)((listener) => locale.subscribe(listener), []);
				const getSnapshot = (0, react.useCallback)(() => locale.getSnapshot(), []);
				const activeLocale = (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot).active;
				(0, react.useLayoutEffect)(() => registerIdeComposerSuppression(slots, props.sessionId), [props.sessionId]);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HarnessIdeView, {
					...props,
					locale: activeLocale
				});
			};
		}
		/** Required Harness services; the conversation package owns the target slot. */
		var inject = ["slots", "locale"];
		/** Register one additive list entry; Chat remains the official default view. */
		function apply(ctx) {
			const { slots, locale } = ctx;
			const ideView = bindHarnessIdeView(slots, locale);
			slots.inject("conversation.view", () => slots.register({
				name: "conversation.view",
				id: IDE_VIEW_ID,
				order: 20,
				label: IDE_VIEW_LABEL
			}, ideView));
		}
		//#endregion
		exports.HARNESS_THEME_TOKENS = HARNESS_THEME_TOKENS;
		exports.HarnessIdeView = HarnessIdeView;
		exports.apply = apply;
		exports.ideFrameHref = ideFrameHref;
		exports.inject = inject;
		exports.registerIdeComposerSuppression = registerIdeComposerSuppression;
		exports.syncHarnessLocaleToFrame = syncHarnessLocaleToFrame;
		exports.syncHarnessThemeToFrame = syncHarnessThemeToFrame;
		exports.watchHarnessTheme = watchHarnessTheme;
		exports.workspaceIdForSession = workspaceIdForSession;
		exports.workspaceTargetForSession = workspaceTargetForSession;
		return module.exports;
	}
});
