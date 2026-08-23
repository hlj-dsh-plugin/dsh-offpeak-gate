window.__ModuleLoader__.load({
	id: "@dsh-external/offpeak-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		const { useCallback, useEffect, useRef, useState } = React;

		// ═══ 常量 ═══
		const NS = "offpeak-gate";
		const API = "/offpeak-gate/api";
		const POLL_MS = 10000;
		const CHANGED_EVENT = "offpeak-gate:changed";

		/** 广播状态变更：同插件的其他组件（如状态条）收到后立即刷新，不必等下一轮询。 */
		function notifyChanged(sessionId) {
			try {
				window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { sessionId } }));
			} catch { /* 忽略 */ }
		}

		// ═══ 宿主通信 ═══
		async function getStatus(sessionId) {
			try {
				const res = await fetch(`${API}?session=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
				const body = await res.json();
				return body !== null && typeof body === "object" && body.ok === true ? body.status : null;
			} catch { return null; }
		}
		async function post(op, sessionId, extra) {
			try {
				const res = await fetch(API, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op, session: sessionId, ...(extra ?? {}) })
				});
				const body = await res.json();
				if (body !== null && typeof body === "object" && body.ok === true) notifyChanged(sessionId);
				return body;
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		}

		/** 轮询会话低峰状态；返回 [status, refresh]（refresh 立即重取）。
		 *  同时监听同插件广播的变更事件，其他组件操作成功后立即刷新。 */
		function useOffpeakStatus(sessionId) {
			const [status, setStatus] = useState(null);
			const [revision, setRevision] = useState(0);
			useEffect(() => {
				let alive = true;
				let timer;
				const load = async () => {
					const next = await getStatus(sessionId);
					if (alive) setStatus(next);
				};
				const onChanged = (event) => {
					const sid = event?.detail?.sessionId;
					if (!sid || sid === sessionId) setRevision((value) => value + 1);
				};
				load();
				timer = setInterval(load, POLL_MS);
				window.addEventListener(CHANGED_EVENT, onChanged);
				return () => { alive = false; clearInterval(timer); window.removeEventListener(CHANGED_EVENT, onChanged); };
			}, [sessionId, revision]);
			const refresh = useCallback(() => setRevision((value) => value + 1), []);
			return [status, refresh];
		}

		/** 每秒跳动的时钟（倒计时用）。 */
		function useNow(active) {
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				if (!active) return;
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [active]);
			return now;
		}

		function formatRemaining(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (hours > 0) return `${hours}h ${minutes}m`;
			if (minutes > 0) return `${minutes}m ${seconds}s`;
			return `${seconds}s`;
		}

		function formatClock(iso) {
			if (typeof iso !== "string") return "";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}

		// ═══ 样式（浅层内联，主题变量跟随 DSW）═══
		const dockStyle = {
			boxSizing: "border-box",
			display: "flex",
			alignItems: "center",
			gap: "10px",
			height: "34px",
			maxWidth: "calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 6px))",
			margin: "0 auto",
			padding: "4px 12px",
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: "12px",
			background: "var(--dsw-specific-tip, rgba(127,127,127,.06))",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "13px",
			lineHeight: "20px"
		};
		const chipStyle = { flex: "none", fontSize: "14px", lineHeight: "20px" };
		const labelStyle = { flex: "none", fontWeight: 600, fontSize: "13px", lineHeight: "20px" };
		const textStyle = { flex: "1", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "12px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" };
		const buttonStyle = {
			flex: "none",
			appearance: "none",
			font: "inherit",
			cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			borderRadius: "8px",
			padding: "2px 10px",
			fontSize: "12px",
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		const buttonPrimaryStyle = { ...buttonStyle, border: "none", background: "var(--dsw-alias-button-info-fill)", color: "#fff" };
		const toggleStyle = {
			width: 28,
			height: 28,
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			border: "none",
			borderRadius: "8px",
			background: "transparent",
			cursor: "pointer",
			fontSize: "14px",
			lineHeight: "14px",
			color: "var(--dsw-alias-label-tertiary)"
		};

		// ═══ 组件：会话头部开关 ═══
		/**
		 * @param {{ sessionId: string, setMode: (enabled: boolean) => Promise<object>, t: (key: string) => string }} props
		 */
		function OffpeakToggle({ sessionId, setMode, t }) {
			const [status, refresh] = useOffpeakStatus(sessionId);
			const [busy, setBusy] = useState(false);
			const enabled = status?.enabled === true;
			const peak = status?.phase === "peak";
			const onClick = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				try {
					await setMode(!enabled);
					refresh();
				} finally {
					setBusy(false);
				}
			}, [busy, enabled, setMode, refresh]);
			return React.createElement("button", {
				type: "button",
				title: t(enabled ? "toggleOff" : "toggleOn"),
				onClick,
				style: { ...toggleStyle, ...(enabled ? { background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-button-info-fill)" } : {}) },
				"aria-pressed": enabled
			}, peak ? "☀️" : "🌙");
		}

		// ═══ 组件：新会话页（空态）工具行开关 ═══
		/**
		 * 新会话/空态页没有会话头部，头部开关不可见；这里在输入卡工具行
		 * 放一个同款开关，仅空态（composerPhase === "blank"）渲染，
		 * 正式会话页自动隐藏（那里有头部开关，避免重复）。
		 * @param {{ sessionId: string, session: { composerPhase?: string } | undefined, setMode: (enabled: boolean) => Promise<object>, t: (key: string) => string }} props
		 */
		function OffpeakHeroToggle({ sessionId, session, setMode, t }) {
			if (session?.composerPhase !== "blank") return null;
			return React.createElement(OffpeakToggle, { sessionId, setMode, t });
		}

		// ═══ 组件：输入框上方状态条 ═══
		/**
		 * @param {{ sessionId: string, setMode: (enabled: boolean) => Promise<object>, force: () => Promise<object>, t: (key: string) => string }} props
		 */
		function OffpeakDock({ sessionId, setMode, force, t }) {
			const [status, refresh] = useOffpeakStatus(sessionId);
			const enabled = status?.enabled === true;
			const waiting = status?.waiting === true;
			const now = useNow(enabled);
			const [busy, setBusy] = useState(false);
			if (!enabled) return null;
			const peak = status.phase === "peak";
			const untilMs = waiting && typeof status.until === "string" ? Date.parse(status.until) : null;
			const remaining = untilMs !== null ? formatRemaining(untilMs - now) : null;
			const nextBoundary = !waiting && peak ? formatClock(status.nextBoundary) : null;
			const run = async (action) => {
				if (busy) return;
				setBusy(true);
				try {
					await action();
					refresh();
				} finally {
					setBusy(false);
				}
			};
			const nodes = [React.createElement("span", { key: "chip", style: chipStyle }, waiting ? "⏳" : (peak ? "☀️" : "🌙"))];
			nodes.push(React.createElement("span", { key: "label", style: labelStyle }, t("title")));
			if (waiting) {
				nodes.push(React.createElement("span", { key: "text", style: textStyle }, `${t("waiting")} ${remaining ?? "…"}`));
				nodes.push(React.createElement("button", {
					key: "force",
					type: "button",
					style: buttonPrimaryStyle,
					disabled: busy,
					title: t("sendNowHint"),
					onClick: () => run(force)
				}, t("sendNow")));
			} else if (peak) {
				const released = status.released === true;
				nodes.push(React.createElement("span", { key: "text", style: textStyle },
					released
						? t("releasedHint")
						: `${t("peakNow")}${nextBoundary ? ` · ${t("resumeAt")} ${nextBoundary}` : ""}`));
			} else {
				nodes.push(React.createElement("span", { key: "text", style: textStyle },
					status.weekend === true ? t("offpeakWeekend") : t("offpeakNow")));
			}
			nodes.push(React.createElement("button", {
				key: "off",
				type: "button",
				style: buttonStyle,
				disabled: busy,
				onClick: () => run(() => setMode(false))
			}, t("off")));
			return React.createElement("div", { style: dockStyle }, nodes);
		}

		// ═══ 词条 ═══
		const zh = {
			title: "低峰模式",
			waiting: "高峰等待中，距低峰还有",
			peakNow: "高峰时段：LLM 请求将阻塞到低峰自动放行",
			releasedHint: "本轮已放行 · 下一条新消息将恢复阻塞",
			offpeakNow: "低峰时段，请求正常发送（5 折计费）",
			offpeakWeekend: "周末全天低峰，请求正常发送（5 折计费）",
			resumeAt: "恢复",
			sendNow: "立即发送",
			sendNowHint: "放行当前轮次：本轮内后续请求不再等待，下一条新消息（新轮次）恢复阻塞",
			off: "关闭",
			toggleOn: "开启低峰模式：高峰阻塞 LLM 请求，低峰自动放行（省 50%）",
			toggleOff: "关闭低峰模式"
		};
		const en = {
			title: "Off-peak mode",
			waiting: "Peak hours — resuming in",
			peakNow: "Peak hours: LLM requests blocked until off-peak",
			releasedHint: "Current turn released · the next new message blocks again",
			offpeakNow: "Off-peak: requests sent now (50% off)",
			offpeakWeekend: "Weekend: all-day off-peak, requests sent now (50% off)",
			resumeAt: "resumes",
			sendNow: "Send now",
			sendNowHint: "Release the current turn: subsequent requests in this turn skip the gate; the next new message (new turn) blocks again",
			off: "Off",
			toggleOn: "Enable off-peak mode: block LLM requests during peak, auto-resume at off-peak (save 50%)",
			toggleOff: "Disable off-peak mode"
		};

		// ═══ apply ═══
		const inject = ["slots", "locale"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "offpeak-gate: dictionaries");
			const actions = (sessionId) => ({
				setMode: async (enabled) => post("mode", sessionId, { enabled }),
				force: async () => post("force", sessionId)
			});
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "offpeak-gate-toggle",
				order: 40,
				locale: NS,
				inject: actions
			}, OffpeakToggle));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "offpeak-gate-dock",
				order: 20,
				locale: NS,
				inject: actions
			}, OffpeakDock));
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "offpeak-gate-hero-toggle",
				order: 60,
				locale: NS,
				inject: actions
			}, OffpeakHeroToggle));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
