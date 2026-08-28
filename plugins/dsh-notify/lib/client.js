/**
 * dsh-notify 浏览器端 bundle → DSH 模块系统组合为 /plugins/dsh-notify/client.js。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 背景（对应 DSH-Exoskeleton 设计文档 NOTIFICATION-PLUGIN-DESIGN.md §6）
 * ════════════════════════════════════════════════════════════════════════
 * 本插件是「可插拔通知显示层」的 web 侧实现：
 *   · 全局右上角 toast 栈，按 kind 分级样式（成功/错误/信息/警告）；
 *   · 对话完成 toast：项目「X」· 标题（第 N 轮）；点击 → 程序化激活会话；
 *   · 服务异常/重启 toast、更新就绪 toast；
 *   · 两种数据源，运行时二选一（互斥，避免双通道重复）：
 *      ┌ 壳桥模式【首选】：检测到 window.__dshExo（壳预加载桥），
 *      │                   订阅 onEvent 渲染壳推送的通知事件；
 *      │                   点击 → __dshExo.send('notify:click', …) + 页面内
 *      │                   ctx.sessions.open() 程序化激活（替代壳侧 DOM hack）。
 *      └ 无壳降级【§6.4】：无桥（浏览器直开 dsh web）→ 订阅 sessions store，
 *                          按 completed 0→1 边缘自绘轮次完成 toast（页面内闭环）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 遵循的硬约束（AGENT.md 已知坑 + 设计未变式）
 * ════════════════════════════════════════════════════════════════════════
 *   · 纯自建覆盖层渲染：toast 栈是插件自己 createElement 的 fixed 容器，
 *     绝不搬动 DSH slot 渲染出来的节点（搬节点 ↔ 框架重渲染互相触发 =
 *     渲染进程 100% CPU 卡死，dsh-ui-tools 踩过两次）——与 dsh-pet 同型。
 *   · 独立 locale NS（dsh-notify）与 data-* 前缀（data-dsh-notify-*）。
 *   · 页面侧异常全部 try/catch 静默降级，绝不抛到 DSH 主进程/页面。
 *   · 桥只做最小白名单 API 消费：onEvent / send / ready / appInfo。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 依赖注入：exports.inject 声明 apply(ctx) 需要的运行时服务
 *   ["sessions", "locale"]（与 dsh-ui-tools 同机制；package.json 的
 *   dsh.client.inject 留空=不静态注入 DSH 源码上下文，运行时动态订阅）。
 * ════════════════════════════════════════════════════════════════════════
 */

window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports_ = module.exports;
		Object.defineProperty(exports_, Symbol.toStringTag, { value: "Module" });

		/* ══════════════════════════════════════════════════════════════
		 * 常量：locale NS / data 前缀 / DOM id
		 * ══════════════════════════════════════════════════════════════ */

		const NS = "dsh-notify";
		const ROOT_ID = "dsh-notify-root";
		const STYLE_ID = "dsh-notify-style";
		/** 同屏最多展示的 toast 数（超出弹最旧的，纯显示层约束） */
		const MAX_VISIBLE = 5;
		/** toast 离场动画时长（ms），与 CSS dsh-notify-out 动画一致 */
		const LEAVE_ANIM_MS = 160;
		/** 会话激活重试：列表瞬态（phase=pending）时最多重试次数/间隔 */
		const ACTIVATE_RETRIES = 4;
		const ACTIVATE_RETRY_MS = 500;

		/* ══════════════════════════════════════════════════════════════
		 * 语言包（独立 locale NS：dsh-notify；zh/en，与 dsh-ui-tools 同构）
		 * ══════════════════════════════════════════════════════════════ */

		const ZH = {
			"toast.sessionDone": "对话完成",
			"toast.sessionDoneBody": "项目「{project}」· {title}",
			"toast.sessionDoneBodyFlat": "{title}",
			"toast.serviceReady": "服务已就绪",
			"toast.serviceError": "DSH 服务异常",
			"toast.serviceRestarting": "DSH 服务正在重启",
			"toast.updateReady": "更新已就绪",
			"toast.clickToOpen": "点击查看会话",
			"toast.clickToInstall": "点击重启安装",
			"toast.dismiss": "关闭",
			"toast.role": "通知"
		};
		const EN = {
			"toast.sessionDone": "Session finished",
			"toast.sessionDoneBody": "Project \"{project}\" · {title}",
			"toast.sessionDoneBodyFlat": "{title}",
			"toast.serviceReady": "Service ready",
			"toast.serviceError": "DSH service error",
			"toast.serviceRestarting": "DSH service restarting",
			"toast.updateReady": "Update ready",
			"toast.clickToOpen": "Click to open session",
			"toast.clickToInstall": "Click to restart & install",
			"toast.dismiss": "Dismiss",
			"toast.role": "Notification"
		};

		/* ══════════════════════════════════════════════════════════════
		 * kind → 显示元数据：样式档位 / 自动关闭时长 / 是否可点击 / 兜底标题 key
		 * ══════════════════════════════════════════════════════════════ */

		const KIND_META = {
			"session-done": { kind: "info", timeout: 8000, clickable: true, labelKey: "toast.sessionDone" },
			"service-ready": { kind: "success", timeout: 6000, clickable: false, labelKey: "toast.serviceReady" },
			"service-error": { kind: "error", timeout: 15000, clickable: true, labelKey: "toast.serviceError" },
			"service-restarting": { kind: "warning", timeout: 12000, clickable: false, labelKey: "toast.serviceRestarting" },
			"update-ready": { kind: "info", timeout: 15000, clickable: true, labelKey: "toast.updateReady" }
		};
		const FALLBACK_KIND_META = KIND_META["session-done"];

		/* ══════════════════════════════════════════════════════════════
		 * 样式：纯自建覆盖层，颜色走 DSW 主题变量（亮/暗色自动适配）
		 * ══════════════════════════════════════════════════════════════ */

		const CSS = `
/* ═══ dsh-notify · 全局 toast 栈 ═══ */
#${ROOT_ID} {
	position: fixed;
	top: 12px;
	right: 12px;
	z-index: 2147483000;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	width: min(360px, calc(100vw - 24px));
	pointer-events: none;
	font-family: var(--dsw-font-s-14, inherit);
	-webkit-font-smoothing: antialiased;
}
#${ROOT_ID} * { box-sizing: border-box; }
[data-dsh-notify-stack] {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	width: 100%;
}
[data-dsh-notify-toast] {
	position: relative;
	pointer-events: auto;
	display: flex;
	flex-direction: column;
	gap: 3px;
	width: 100%;
	padding: 10px 30px 10px 14px;
	border-radius: 12px;
	background: color-mix(in srgb, var(--dsw-specific-menu, #ffffff) 96%, transparent);
	border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08));
	box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
	backdrop-filter: blur(14px) saturate(1.3);
	-webkit-backdrop-filter: blur(14px) saturate(1.3);
	color: var(--dsw-alias-label-primary, #1a1d23);
	overflow: hidden;
	animation: dsh-notify-in .22s cubic-bezier(.4, 0, .2, 1) ease-out;
}
[data-dsh-notify-toast]::before {
	content: "";
	position: absolute;
	left: 0;
	top: 11px;
	bottom: 11px;
	width: 3px;
	border-radius: 2px;
	background: var(--dsw-alias-brand-primary, #4176e6);
}
[data-dsh-notify-toast][data-dsh-notify-kind="success"]::before { background: var(--dsw-alias-state-success-primary, #2fa360); }
[data-dsh-notify-toast][data-dsh-notify-kind="error"]::before   { background: var(--dsw-alias-state-error-primary, #d5484f); }
[data-dsh-notify-toast][data-dsh-notify-kind="warning"]::before { background: var(--dsw-alias-state-warning-primary, #d17d00); }
[data-dsh-notify-toast][data-dsh-notify-clickable] { cursor: pointer; }
[data-dsh-notify-toast][data-dsh-notify-clickable]:hover {
	border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 40%, var(--dsw-alias-border-l2, rgba(0,0,0,.08)));
}
[data-dsh-notify-toast][data-dsh-notify-leaving="true"] {
	animation: dsh-notify-out ${LEAVE_ANIM_MS}ms ease-in forwards !important;
}
[data-dsh-notify-title] {
	font-size: 13px;
	font-weight: 600;
	line-height: 18px;
	color: var(--dsw-alias-label-primary, #1a1d23);
	word-break: break-word;
}
[data-dsh-notify-body] {
	font-size: 12px;
	line-height: 17px;
	color: var(--dsw-alias-label-secondary, #5c6470);
	word-break: break-word;
	white-space: pre-wrap;
}
[data-dsh-notify-meta] {
	font-size: 11px;
	line-height: 15px;
	color: var(--dsw-alias-label-tertiary, #8a919c);
}
[data-dsh-notify-close] {
	position: absolute;
	top: 6px;
	right: 6px;
	width: 20px;
	height: 20px;
	display: flex;
	align-items: center;
	justify-content: center;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--dsw-alias-label-tertiary, #8a919c);
	font-size: 14px;
	line-height: 1;
	cursor: pointer;
	opacity: .85;
}
[data-dsh-notify-close]:hover {
	background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
	color: var(--dsw-alias-label-primary, #1a1d23);
	opacity: 1;
}
@keyframes dsh-notify-in {
	from { opacity: 0; transform: translateX(10px); }
	to   { opacity: 1; transform: none; }
}
@keyframes dsh-notify-out {
	from { opacity: 1; transform: none; }
	to   { opacity: 0; transform: translateX(16px); }
}
`.trim();

		/* ══════════════════════════════════════════════════════════════
		 * toast 管理器（自建 DOM，纯显示层）
		 * ══════════════════════════════════════════════════════════════ */

		/** key -> { key, el, timer, closing, params }（Map 保留插入序，用于溢出淘汰最旧） */
		const toasts = new Map();
		let rootEl = null;
		let stackEl = null;
		let styleEl = null;

		function ensureRoot() {
			if (typeof document === "undefined") return;
			try {
				if (!styleEl || !styleEl.isConnected) {
					styleEl = document.createElement("style");
					styleEl.id = STYLE_ID;
					styleEl.setAttribute("data-dsh-notify", "");
					styleEl.textContent = CSS;
					(document.head || document.documentElement).appendChild(styleEl);
				}
				if (!rootEl || !rootEl.isConnected) {
					rootEl = document.createElement("div");
					rootEl.id = ROOT_ID;
					rootEl.setAttribute("data-dsh-notify", "");
					rootEl.setAttribute("data-dsh-notify-role", "toast-stack");
					rootEl.setAttribute("role", "region");
					rootEl.setAttribute("aria-live", "polite");
					rootEl.setAttribute("aria-label", "notifications");
					stackEl = document.createElement("div");
					stackEl.setAttribute("data-dsh-notify-stack", "");
					rootEl.appendChild(stackEl);
					document.body.appendChild(rootEl);
				}
			} catch (err) {
				try { console.warn("[dsh-notify] ensureRoot failed", err); } catch (_) {}
			}
		}

		function teardownRoot() {
			try {
				toasts.clear();
				if (rootEl && rootEl.isConnected) rootEl.remove();
				rootEl = null;
				stackEl = null;
				if (styleEl && styleEl.isConnected) styleEl.remove();
				styleEl = null;
			} catch (_) {}
		}

		/** 重建一个 toast 元素的内容（创建与原位刷新共用；el 自身的事件绑定不变） */
		function renderInto(el, params) {
			el.setAttribute("data-dsh-notify-kind", params.kind || "info");
			if (params.onClick) el.setAttribute("data-dsh-notify-clickable", "");
			else el.removeAttribute("data-dsh-notify-clickable");
			var children = [];
			var title = document.createElement("div");
			title.setAttribute("data-dsh-notify-title", "");
			title.textContent = params.title || "";
			children.push(title);
			if (params.body) {
				var body = document.createElement("div");
				body.setAttribute("data-dsh-notify-body", "");
				body.textContent = params.body;
				children.push(body);
			}
			if (params.metaText) {
				var meta = document.createElement("div");
				meta.setAttribute("data-dsh-notify-meta", "");
				meta.textContent = params.metaText;
				children.push(meta);
			}
			var close = document.createElement("button");
			close.setAttribute("data-dsh-notify-close", "");
			close.setAttribute("aria-label", params.dismissLabel || "close");
			close.type = "button";
			close.textContent = "×";
			children.push(close);
			el.replaceChildren(...children);
		}

		function buildToastEl(key, params) {
			var el = document.createElement("div");
			el.setAttribute("data-dsh-notify-toast", "");
			el.setAttribute("role", "status");
			renderInto(el, params);
			el.addEventListener("click", (e) => {
				var target = e.target;
				if (target && typeof target.closest === "function" && target.closest("[data-dsh-notify-close]")) {
					dismiss(key);
					return;
				}
				dismiss(key, { callOnClick: true });
			});
			return el;
		}

		/**
		 * 入栈一条 toast。
		 * @param params {key, kind, title, body, metaText, timeout, dismissLabel,
		 *                onClick, onSeen, replace}
		 *   - key：去重键；同 key 已存在时，replace=false 直接忽略（去重），
		 *     replace=true 原位刷新内容并重置计时（无壳降级同会话连发时用，避免堆积）。
		 */
		function push(params) {
			if (!params || !params.title) return;
			ensureRoot();
			if (!rootEl || !stackEl) return;
			var key = params.key || "toast:" + Date.now() + ":" + Math.random().toString(36).slice(2);
			var existing = toasts.get(key);
			if (existing) {
				// 已在离场动画中：先丢弃旧的再走正常入栈（原位刷新一个消失中的 toast 无意义）
				if (existing.closing) dismissNow(key);
				else if (!params.replace) return;
				else { refreshToast(existing, params); return; }
			}
			while (toasts.size >= MAX_VISIBLE) {
				var firstKey = toasts.keys().next().value;
				if (firstKey === undefined) break;
				dismissNow(firstKey);
			}
			var el = buildToastEl(key, params);
			stackEl.appendChild(el);
			var rec = { key, el, timer: null, closing: false, params };
			toasts.set(key, rec);
			rec.timer = setTimeout(() => dismiss(key), params.timeout ?? 8000);
			if (typeof params.onSeen === "function") {
				try { params.onSeen(); } catch (_) {}
			}
		}

		function refreshToast(rec, params) {
			try {
				if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
				renderInto(rec.el, params);
				rec.params = { ...rec.params, ...params };
				rec.timer = setTimeout(() => dismiss(rec.key), params.timeout ?? 8000);
			} catch (_) {}
		}

		/** 动画离场后移除；可选携带 onClick */
		function dismiss(key, opts) {
			var rec = toasts.get(key);
			if (!rec || rec.closing) return;
			rec.closing = true;
			if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
			try {
				if (opts && opts.callOnClick && typeof rec.params.onClick === "function") {
					try { rec.params.onClick(); } catch (_) {}
				}
				rec.el.setAttribute("data-dsh-notify-leaving", "true");
			} catch (_) {}
			setTimeout(() => dismissNow(key), LEAVE_ANIM_MS);
		}

		/** 立即移除（溢出淘汰 / 离场动画结束后兜底） */
		function dismissNow(key) {
			var rec = toasts.get(key);
			if (!rec) return;
			if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
			try { rec.el.remove(); } catch (_) {}
			toasts.delete(key);
		}

		/* ══════════════════════════════════════════════════════════════
		 * 工具：会话 id 归一化 / 项目名
		 * ══════════════════════════════════════════════════════════════ */

		/** DSH SessionId 形如 "session-<uuid>"；壳 watcher 事件里的 uuid 无前缀 → 统一补前缀 */
		function normalizeSessionId(id) {
			if (typeof id !== "string" || !id) return id;
			return id.startsWith("session-") ? id : "session-" + id;
		}

		function projectNameFromCwd(cwd) {
			if (typeof cwd !== "string" || !cwd) return "";
			var cleaned = cwd.replace(/[\\/]+$/, "");
			var idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
			return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
		}

		function bridgeOf() {
			try {
				var b = typeof window !== "undefined" ? window.__dshExo : undefined;
				return b && typeof b === "object" ? b : undefined;
			} catch (_) { return undefined; }
		}

		function sendBridge(channel, payload) {
			try {
				var b = bridgeOf();
				if (b && typeof b.send === "function") b.send(channel, payload || {});
			} catch (err) {
				try { console.warn("[dsh-notify] bridge.send failed", err); } catch (_) {}
			}
		}

		/* ══════════════════════════════════════════════════════════════
		 * §6.3 程序化激活会话（替代壳侧 __reactFiber$ DOM hack）
		 * 首选：ctx.sessions.open(id)（已验证 ISessions.open 存在）。
		 * 防御：列表瞬态（phase=pending）时按 id 校验存在性再 open，
		 *       unknown id 会 fail loud → 先查 byId/ids 再调，避免炸进插件。
		 * ══════════════════════════════════════════════════════════════ */

		function activateSession(ctx, sessionId) {
			try {
				if (!sessionId || !ctx.sessions || !ctx.sessions.list) return;
				var want = normalizeSessionId(sessionId);
				var openOnce = () => {
					try {
						var snap = ctx.sessions.list.getSnapshot();
						var ids = Array.isArray(snap.ids) ? snap.ids : [];
						var found = ids.some((id) => normalizeSessionId(id) === want);
						if (!found) return false;
						ctx.sessions.open(want);
						return true;
					} catch (err) {
						try { console.warn("[dsh-notify] sessions.open failed", err); } catch (_) {}
						return false;
					}
				};
				if (openOnce()) return;
				// 轻量重试（bounded）：列表未就绪 / 会话刚建还未入列时兜底
				var attempts = 0;
				var timer = setInterval(() => {
					attempts += 1;
					if (attempts > ACTIVATE_RETRIES) { clearInterval(timer); return; }
					try {
						var snap = ctx.sessions.list.getSnapshot();
						if (snap.current === want) { clearInterval(timer); return; }
					} catch (_) { clearInterval(timer); return; }
					if (openOnce()) clearInterval(timer);
				}, ACTIVATE_RETRY_MS);
			} catch (err) {
				try { console.warn("[dsh-notify] activateSession failed", err); } catch (_) {}
			}
		}

		/* ══════════════════════════════════════════════════════════════
		 * 桥契约消费（设计 §5.1）：window.__dshExo
		 *   onEvent(cb: (ev: NotificationEvent) => void): () => void
		 *   send(channel: 'notify:click'|'notify:seen', { id, sessionId? }): void
		 *   ready(): void
		 *   appInfo(): { version: string }
		 * NotificationEvent（设计 §3.1）：
		 *   { id, kind, title, body, ts, session?, service?, update? }
		 * ══════════════════════════════════════════════════════════════ */

		function handleBridgeEvent(ctx, t, ev) {
			if (!ev || typeof ev.id !== "string" || !ev.id) return;
			// 控制类事件：会话激活请求（原生通知点击后壳转发的可靠激活路径，修复「偶尔不跳转」）。
			// 只激活、不渲染 toast。
			if (ev.kind === "session-activate") {
				var rawSid = ev.session && (ev.session.sessionId || ev.session.uuid);
				if (rawSid) activateSession(ctx, normalizeSessionId(rawSid));
				return;
			}
			var meta = KIND_META[ev.kind] || FALLBACK_KIND_META;
			var rawSession = ev.session && (ev.session.sessionId || ev.session.uuid);
			var sessionId = rawSession ? normalizeSessionId(rawSession) : undefined;
			var title = typeof ev.title === "string" && ev.title
				? ev.title
				: (meta.labelKey ? t(meta.labelKey) : "");
			var body = typeof ev.body === "string" ? ev.body : "";
			// 分级 meta 文案（P2 review 修正）：更新就绪 → 「点击重启安装」；会话/异常类 → 「点击查看会话」
			var metaText = ev.kind === "update-ready"
				? t("toast.clickToInstall")
				: (meta.clickable ? t("toast.clickToOpen") : "");
			push({
				key: "ev:" + ev.id,
				kind: meta.kind,
				title,
				body,
				metaText: metaText,
				timeout: meta.timeout,
				dismissLabel: t("toast.dismiss"),
				onClick: () => {
					// 1) 页面内程序化激活（会话类事件；壳只负责唤起窗口）
					if (sessionId) activateSession(ctx, sessionId);
					// 2) 回传壳：更新就绪 → notify:install（触发安装，P2）；其余 → notify:click（唤起窗口）
					if (ev.kind === "update-ready") {
						sendBridge("notify:install", { id: ev.id });
					} else {
						sendBridge("notify:click", { id: ev.id, sessionId: sessionId || undefined });
					}
				},
				onSeen: () => {
					// 已读回执：壳侧 hub 靠此得知插件已接收，避免重投
					sendBridge("notify:seen", { id: ev.id, sessionId: sessionId || undefined });
				}
			});
		}

		function setupBridge(ctx, t) {
			var bridge = bridgeOf();
			if (!bridge) return null;
			try {
				if (typeof bridge.appInfo === "function") {
					var info = bridge.appInfo();
					try { console.log("[dsh-notify] shell bridge ready", info || ""); } catch (_) {}
				}
			} catch (_) {}

			var stopped = false;
			var unsubscribe = null;
			if (typeof bridge.onEvent === "function") {
				try {
					unsubscribe = bridge.onEvent((ev) => {
						if (stopped) return;
						try { handleBridgeEvent(ctx, t, ev); } catch (err) {
							try { console.warn("[dsh-notify] onEvent handler failed", err); } catch (_) {}
						}
					});
				} catch (err) {
					try { console.warn("[dsh-notify] bridge.onEvent failed", err); } catch (_) {}
				}
			}
			// 握手：插件就绪后再投递，防"事件先于页面就绪被丢"（设计 §5.2）
			try { if (typeof bridge.ready === "function") bridge.ready(); } catch (_) {}

			return () => {
				stopped = true;
				try { if (typeof unsubscribe === "function") unsubscribe(); } catch (_) {}
			};
		}

		/* ══════════════════════════════════════════════════════════════
		 * 无壳降级（设计 §6.4）：直接浏览器开 dsh web、无 __dshExo。
		 * 订阅 ctx.sessions.list，按 completed 0→1 边缘自绘轮次完成 toast。
		 * completed = 侧边栏绿色 "done" 标记（运行中→完成且未选中）。
		 * 基线：插件加载时已有 completed 的会话不打扰，只响应之后的新边缘。
		 * ══════════════════════════════════════════════════════════════ */

		function setupSessionsFallback(ctx, t) {
			if (!ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.subscribe !== "function") return null;
			var prev = new Map();       // sessionId -> boolean(completed)
			var baseline = true;

			var onSnap = () => {
				try {
					var snap = ctx.sessions.list.getSnapshot();
					var ids = Array.isArray(snap.ids) ? snap.ids : [];
					var currentId = snap.current;
					for (var i = 0; i < ids.length; i++) {
						var id = ids[i];
						var s = snap.byId && snap.byId[id];
						if (!s) continue;
						var now = !!s.completed;
						prev.set(id, now);
						if (baseline) continue;        // 基线只记录既有状态，不触发
						if (!now) continue;            // 只处理 completed 0→1 边缘
						if (s.blank) continue;         // 空白会话不提醒
						if (id === currentId) continue; // 正看着的不提醒（与侧边栏 done 一致）
						var title = s.displayTitle || s.title || id;
						var project = projectNameFromCwd(typeof s.cwd === "string" ? s.cwd : "");
						var body = project
							? t("toast.sessionDoneBody", { project, title })
							: t("toast.sessionDoneBodyFlat", { title });
						push({
							// 同会话已在屏则原位刷新（replace），避免连续多轮堆积成通知风暴
							key: "fb:" + id,
							kind: "info",
							title: t("toast.sessionDone"),
							body,
							metaText: t("toast.clickToOpen"),
							timeout: 8000,
							dismissLabel: t("toast.dismiss"),
							replace: true,
							onClick: () => activateSession(ctx, id)
						});
					}
					if (!baseline) {
						for (var k of prev.keys()) {
							if (!ids.includes(k)) prev.delete(k);
						}
					}
				} catch (err) {
					try { console.warn("[dsh-notify] sessions fallback scan failed", err); } catch (_) {}
				}
			};

			var unsubscribe = ctx.sessions.list.subscribe(onSnap);
			// 初始基线扫描（记录当前状态，不触发任何 toast）
			try { onSnap(); } catch (_) {}
			baseline = false;

			return () => {
				try { if (typeof unsubscribe === "function") unsubscribe(); } catch (_) {}
			};
		}

		/* ══════════════════════════════════════════════════════════════
		 * apply：装配
		 * ══════════════════════════════════════════════════════════════ */

		function apply(ctx) {
			// 1) 语言包（独立 NS：dsh-notify）
			ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "dsh-notify: register locale");
			var t = ctx.locale.bind(NS);

			// 2) 覆盖层（样式 + toast 栈根）：纯自建 DOM，卸载时整体拆除
			ctx.effect(() => {
				ensureRoot();
				return () => teardownRoot();
			}, "dsh-notify: toast overlay root");

			// 3) 数据源：壳桥优先；无桥则 sessions store 降级（互斥，双通道防重复）
			ctx.effect(() => {
				var bridgeCleanup = setupBridge(ctx, t);
				if (bridgeCleanup) return bridgeCleanup;
				var fallbackCleanup = setupSessionsFallback(ctx, t);
				return fallbackCleanup || (() => {});
			}, "dsh-notify: notification source");
		}

		/* 运行时服务注入声明：无壳降级与程序化激活需要 sessions；语言需要 locale。
		 * （与 dsh-ui-tools 同机制；package.json 的 dsh.client.inject 仍留空 = 不静态注入源码上下文） */
		var inject = ["sessions", "locale"];

		exports_.apply = apply;
		exports_.inject = inject;
		return module.exports;
	}
});
