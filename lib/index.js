import z from "@deepseek-ai/schemastery";

/**
 * offpeak-gate — 低峰期闸门。
 *
 * 会话级开关（默认关）。开启后，本会话（及 fork 继承的子会话）的每次
 * LLM 请求在高峰时段都会被阻塞在 `agent/request` 瀑布里，直到低峰边界
 * 到达才放行。等待期间用户新消息正常进入 inbox 排队（会话日志已含消息，
 * 不会丢），低峰到达后同一 turn 继续、随后处理排队消息。
 *
 * 实现要点：
 * - 阻塞点：`agent/request`（agent 循环每个 LLM 请求前的瀑布），等待是
 *   分片 + AbortSignal 可取消的，不依赖任何工具超时策略。
 * - 持久化：开关**不写会话日志**（插件自有事件会让不认识该词汇的 harness
 *   拒绝读取整份日志），而是经 settings 的 `modes` 字段按会话 id 持久化
 *   （重启后仍生效；fork 出的子会话通过 `header.forkedFrom` 继承父会话
 *   状态）。
 * - 状态：等待中/已就绪为进程内状态（`waitStates`），仅驱动页面状态条，
 *   不落日志。
 * - 控制：loopback-only 的 `/offpeak-gate/api` 路由（GET 状态 / POST
 *   mode 开关 / POST force 立即放行一次，可打断正在进行的等待）。
 *
 * @module @dsh-external/offpeak-gate
 */

export const name = "offpeak-gate";
export const inject = ["webServer"];

export const Config = z.object({
  /** 计算峰谷时段的 IANA 时区（默认北京）。 */
  timeZone: z.string().default("Asia/Shanghai"),
  /** 高峰窗口列表 [开始小时, 结束小时)，本地时区 0-23。仅工作日生效。 */
  peakWindows: z.array(z.tuple([z.number(), z.number()])).default([[9, 12], [14, 18]]),
  /** 周末全天视为低峰（官方规则：2026-08-23 起周六、周日全天不区分峰谷，统一按低谷价）。 */
  weekendsOffpeak: z.boolean().default(true),
  /** 等待循环的单个 sleep 分片长度（Node timer 上限保护）。 */
  chunkMs: z.number().min(1000).default(600000),
  /** 单次最多等待分钟数；0 = 不限（默认）。超过则提前放行。 */
  maxWaitMinutes: z.number().min(0).default(0),
  /** 控制路由路径。 */
  routePath: z.string().default("/offpeak-gate/api"),
  /**
   * 会话级开关持久化（内部状态，非用户配置）：sessionId -> enabled。
   * 重启后从这里恢复；进程内读写以 modeCache 为准。
   */
  modes: z.dict(z.boolean()).default({}),
});

/** 设置命名空间（设置页可改峰谷窗口）。 */
export const GATE_SETTINGS_NAMESPACE = "offpeak-gate";

const WEEKEND = new Set(["Sat", "Sun"]);

/** 本进程内的放行状态：forceActive = 待消费的一次放行；forceTurns = 已放行的 turn 号（本轮内不再阻塞）。 */
const forceActive = /* @__PURE__ */ new Set();
const forceTurns = /* @__PURE__ */ new Map();
const wakes = /* @__PURE__ */ new Map();
/** 会话开关缓存（进程内即时生效；settings.modes 负责重启后恢复）。 */
const modeCache = /* @__PURE__ */ new Map();
/** 进行中的低峰等待（仅驱动状态条；不落日志，重启后自然清空）。 */
const waitStates = /* @__PURE__ */ new Map();

/** 解析目标时区的当前时钟：星期 + 当日分钟数。 */
export function zonedClock(timeZone, date = new Date()) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false
		}).formatToParts(date).map((part) => [part.type, part.value])
	);
	const hour = parts.hour === "24" ? 0 : Number(parts.hour);
	return { dow: parts.weekday, minutes: hour * 60 + Number(parts.minute) };
}

/** 当前时刻是否处于高峰窗口。 */
export function isPeak(clock, cfg) {
	if (cfg.weekendsOffpeak && WEEKEND.has(clock.dow)) return false;
	return cfg.peakWindows.some(([start, end]) => clock.minutes >= start * 60 && clock.minutes < end * 60);
}

/** 下一个低峰边界时刻（调用前提：当前为高峰）。 */
export function nextOffpeakAt(cfg, now) {
	const clock = zonedClock(cfg.timeZone, now);
	const containing = cfg.peakWindows.find(([start, end]) => clock.minutes >= start * 60 && clock.minutes < end * 60);
	const boundaryMinutes = (containing === undefined ? 24 : containing[1]) * 60;
	// 先对齐整分，再按分钟差平移，最后夏令时微调（整分钟步进）
	const floored = new Date(now.getTime());
	floored.setSeconds(0, 0);
	const targetMinutes = boundaryMinutes % (24 * 60);
	let target = new Date(floored.getTime() + (boundaryMinutes - clock.minutes) * 60000);
	for (let i = 0; i < 12 && zonedClock(cfg.timeZone, target).minutes !== targetMinutes; i++) {
		target = new Date(target.getTime() + 60000);
	}
	if (target.getTime() <= now.getTime()) target = new Date(target.getTime() + 60000);
	return target;
}

/** 会话开关读取：进程内缓存优先，其次 settings 持久化；沿 forkedFrom 链向上继承。 */
function makeModeReader(ctx) {
	const sessions = ctx.get("sessions");
	const readOwn = (session) => {
		if (modeCache.has(session.id)) return modeCache.get(session.id);
		const modes = current()?.modes;
		return modes === undefined || !Object.hasOwn(modes, session.id) ? undefined : modes[session.id] === true;
	};
	return (session) => {
		let current = session;
		for (let depth = 0; depth < 32; depth++) {
			const own = readOwn(current);
			if (own !== undefined) return own;
			const parentId = current.header?.forkedFrom;
			if (parentId === undefined || sessions === undefined) break;
			const parent = sessions.get(parentId);
			if (parent === undefined) break;
			current = parent;
		}
		return false;
	};
}

/** 追加会话开关状态：进程内缓存即时生效，settings.modes 持久化供重启恢复。 */
function persistMode(ctx, sessionId, enabled) {
	modeCache.set(sessionId, enabled);
	const settings = ctx.get("settings");
	if (settings === undefined) return;
	settings.mutate(GATE_SETTINGS_NAMESPACE, [{ op: "set", path: ["modes", sessionId], value: enabled }]).catch((error) => {
		ctx.logger?.warn?.("offpeak-gate: 开关持久化失败（仅影响重启后恢复）: %s", String(error));
	});
}

/** 可取消的分片睡眠：signal 中止返回 false，正常到时返回 true。 */
function cancellableDelay(ms, signal) {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** 创建/取回某会话的唤醒器（force 时 resolve("force")）。 */
function wakeOf(sessionId) {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	const wake = { promise, resolve };
	wakes.set(sessionId, wake);
	return wake;
}

/** 阻塞等待到 untilMs；返回 "go"（放行）或 "abort"（被取消）。 */
export async function waitUntil(session, untilMs, signal, cfg, readEnabled) {
	while (Date.now() < untilMs) {
		if (signal?.aborted) return "abort";
		if (!readEnabled(session)) return "go"; // 等待期间开关被关 → 放行本次
		if (cfg.maxWaitMinutes > 0 && Date.now() + cfg.maxWaitMinutes * 60000 < untilMs) return "go";
		const remaining = untilMs - Date.now();
		const chunk = Math.min(remaining, cfg.chunkMs);
		const wake = wakeOf(session.id);
		const result = await Promise.race([
			cancellableDelay(chunk, signal),
			wake.promise
		]);
		if (wakes.get(session.id) === wake) wakes.delete(session.id);
		if (result === "force") return "force"; // 被"立即发送"唤醒 → 调用方记为本轮放行
		if (signal?.aborted) return "abort";
	}
	return "go";
}

function isLoopbackHost(host) {
	return typeof host === "string" && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu.test(host);
}

function readJsonBody(req) {
	return new Promise((resolve) => {
		let text = "";
		req.on("data", (chunk) => { text += chunk; });
		req.on("end", () => {
			if (text.length === 0) { resolve(undefined); return; }
			try { resolve(JSON.parse(text)); } catch { resolve(undefined); }
		});
		req.on("error", () => resolve(undefined));
	});
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/** 计算一个会话的页面可见状态。 */
function statusOf(session, cfg, readEnabled) {
	const enabled = readEnabled(session);
	const now = new Date();
	const clock = zonedClock(cfg.timeZone, now);
	const peak = isPeak(clock, cfg);
	const waitingState = waitStates.get(session.id);
	const waiting = enabled && waitingState !== undefined && Date.parse(waitingState.until) > now.getTime();
	return {
		enabled,
		phase: peak ? "peak" : "offpeak",
		weekend: cfg.weekendsOffpeak && WEEKEND.has(clock.dow),
		waiting,
		released: forceTurns.has(session.id),
		until: waiting ? waitingState.until : null,
		nextBoundary: peak ? nextOffpeakAt(cfg, now).toISOString() : null,
		timeZone: cfg.timeZone,
		peakWindows: cfg.peakWindows,
		weekendsOffpeak: cfg.weekendsOffpeak,
		now: now.toISOString()
	};
}

/** 控制路由：GET 状态 / POST {op:"mode"|"force"|"config"}。 */
function apiRoute(ctx, readEnabled) {
	return async (req, res) => {
		if (!isLoopbackHost(req.headers.host)) {
			json(res, 403, { ok: false, error: "loopback only" });
			return;
		}
		const url = new URL(req.url, "http://localhost");
		const sessions = ctx.get("sessions");
		const resolveSession = (sessionId) => (sessionId === null || sessions === undefined ? undefined : sessions.get(sessionId));
		const cfg = current();
		if (req.method === "GET") {
			const session = resolveSession(url.searchParams.get("session"));
			if (session === undefined) return json(res, 200, { ok: false, error: "session-not-found" });
			return json(res, 200, { ok: true, status: statusOf(session, cfg, readEnabled) });
		}
		if (req.method === "POST") {
			const body = await readJsonBody(req);
			const session = resolveSession(url.searchParams.get("session") ?? body?.session);
			const op = body?.op;
			if (op === "mode") {
				if (session === undefined) return json(res, 200, { ok: false, error: "session-not-found" });
				const enabled = body.enabled === true;
				persistMode(ctx, session.id, enabled);
				if (!enabled) {
					forceActive.delete(session.id);
					forceTurns.delete(session.id);
					waitStates.delete(session.id);
				}
				return json(res, 200, { ok: true });
			}
			if (op === "force") {
				if (session === undefined) return json(res, 200, { ok: false, error: "session-not-found" });
				forceActive.add(session.id);
				const wake = wakes.get(session.id);
				if (wake !== undefined) {
					wakes.delete(session.id);
					wake.resolve("force");
				}
				return json(res, 200, { ok: true });
			}
			if (op === "config") {
				const settings = ctx.get("settings");
				if (settings === undefined) return json(res, 200, { ok: false, error: "settings-unavailable" });
				const patch = body.config;
				if (patch === null || typeof patch !== "object") return json(res, 400, { ok: false, error: "expected config object" });
				const ops = [];
				for (const key of ["timeZone", "peakWindows", "weekendsOffpeak", "chunkMs", "maxWaitMinutes", "routePath"]) {
					if (key in patch) ops.push({ op: "set", path: [key], value: patch[key] });
				}
				if (ops.length === 0) return json(res, 200, { ok: true });
				try {
					await settings.mutate(GATE_SETTINGS_NAMESPACE, ops);
					return json(res, 200, { ok: true });
				} catch (error) {
					return json(res, 200, { ok: false, error: String(error) });
				}
			}
			return json(res, 400, { ok: false, error: "unknown op" });
		}
		return json(res, 405, { ok: false, error: "method not allowed" });
	};
}

let current = () => ({ peakWindows: [[9, 12], [14, 18]], timeZone: "Asia/Shanghai", weekendsOffpeak: true, chunkMs: 600000, maxWaitMinutes: 0 });

/** 插件入口。 */
export function apply(ctx, config) {
	current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, GATE_SETTINGS_NAMESPACE, Config, config, {
			setSource: (source) => { current = source; },
			onChange: () => {}
		});
	});
	const readEnabled = makeModeReader(ctx);
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: config.routePath, handler: apiRoute(ctx, readEnabled) }),
		"offpeak-gate: control route"
	);
	// 闸门：每个 LLM 请求发出前，若开关开启且当前为高峰 → 阻塞到低峰。
	// 放行粒度 = 本轮（turn）：force 后同一 turn 的后续 step 不再阻塞，下一 turn 恢复。
	const disposeGate = ctx.on("agent/request", (payload, next) => {
		const { agent, signal } = payload;
		if (agent === undefined || agent.session === undefined) return next();
		const session = agent.session;
		const cfg = current();
		try {
			if (!readEnabled(session)) return next();
			const now = new Date();
			if (!isPeak(zonedClock(cfg.timeZone, now), cfg)) return next();
			const releasedTurn = forceTurns.get(session.id);
			if (releasedTurn !== undefined) {
				if (releasedTurn === payload.turn) return next();
				forceTurns.delete(session.id); // 进入新 turn → 放行过期
			}
			if (forceActive.delete(session.id)) {
				forceTurns.set(session.id, payload.turn);
				return next();
			}
			const until = nextOffpeakAt(cfg, now);
			waitStates.set(session.id, { until: until.toISOString() });
			return waitUntil(session, until.getTime(), signal, cfg, readEnabled).then((kind) => {
				if (kind === "force") forceTurns.set(session.id, payload.turn);
				waitStates.delete(session.id);
				if (kind === "abort") return void 0;
				return next();
			});
		} catch (error) {
			ctx.logger?.warn?.("offpeak-gate: gate error: %s", String(error));
			return next();
		}
	});
	ctx.effect(() => () => { disposeGate(); }, "offpeak-gate: gate listener");
	ctx.logger?.info?.("[offpeak-gate] 低峰闸门已启动（时区 %s，高峰窗口 %s，周末低峰 %s）",
		config.timeZone, JSON.stringify(config.peakWindows), String(config.weekendsOffpeak));
}
