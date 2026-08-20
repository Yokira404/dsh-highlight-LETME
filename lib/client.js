/**
 * dsh-plugin-letme-annotator — browser half (client bundle).
 *
 * 【插件】自动标注LetMe
 *
 * Watches assistant thinking blocks. Whenever the reasoning text contains
 * "let me" (case-insensitive), a red badge "出现了 let me" is placed right
 * after the "Think" title, and every actual occurrence of the phrase inside
 * the reasoning text is highlighted in red at its exact position (CSS Custom
 * Highlight API; the old whole-row left bar is only a fallback when that API
 * is unavailable). The badge/highlights stay in sync while the reasoning is
 * streaming and disappear again when the flagged phrase disappears (e.g.
 * retry rewrites).
 *
 * Content source: the session snapshot (chat nodes → reasoning blocks), which
 * carries the FULL reasoning text even while the disclosure row is collapsed
 * (the collapsed DOM only shows the first line). A DOM-text fallback covers
 * rows whose node is not (yet) resolvable in the snapshot.
 *
 * Bundle format: the client module system's lazy-CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`), exporting `apply` and
 * `inject` exactly like the first-party `dsh-client-ui-*` packages.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-letme-annotator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---- editable policy ----
		/** Phrase patterns flagged inside the thinking text. */
		const PATTERNS = [/\blet me\b/giu];
		/** Badge label (base text; a "×N" suffix is appended when N > 1). */
		const BADGE_LABEL = "出现了 let me";
		/** Think disclosure rows (ReasoningRow root). */
		const THINK_SELECTOR = '[data-variant="think"]';
		/** Badge marker used to find/remove our own elements. */
		const BADGE_ATTR = "data-letme-annotator";
		const BADGE_SELECTOR = `[${BADGE_ATTR}="badge"]`;
		/** Row flag attribute (fallback red-accent mode only). */
		const FLAG_ATTR = "data-letme-flagged";
		/** CSS Custom Highlight registry name (word-position marking). */
		const HIGHLIGHT_NAME = "letme-annotator";
		const CSS_ID = "dsh-plugin-letme-annotator/badge";
		const CSS_TEXT = [
			`.letme-annotator-badge{display:inline-flex;align-items:center;flex:none;margin-left:8px;padding:0 6px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 55%,transparent);border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 14%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px;font-weight:600;line-height:18px;white-space:nowrap;user-select:none}`,
			`::highlight(${HIGHLIGHT_NAME}){background-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 30%,transparent);color:inherit}`,
			`[data-variant="think"][data-letme-flagged="true"]{box-shadow:inset 3px 0 0 color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 70%,transparent)}`
		].join("\n");

		// ---- plumbing ----
		let dirty = false;
		let sessionUnsubscribe = null;
		let lastCurrentId;

		function log(message, error) {
			// eslint-disable-next-line no-console
			console.warn(`[letme-annotator] ${message}`, error ?? "");
		}

		/** Debounce reconcile to one run per microtask. */
		function scheduleReconcile() {
			if (dirty) return;
			dirty = true;
			queueMicrotask(() => {
				dirty = false;
				try {
					reconcile();
				} catch (error) {
					log("reconcile failed", error);
				}
			});
		}

		function ensureStyles() {
			if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}

		// ---- flag computation (authoritative text from the session snapshot) ----
		function matchCount(text) {
			let count = 0;
			for (const pattern of PATTERNS) {
				const clone = new RegExp(pattern.source, pattern.flags.replace(/g/gu, "") + "g");
				clone.lastIndex = 0;
				const found = text.match(clone);
				if (found !== null) count += found.length;
			}
			return count;
		}

		function eachChatNode(chat, visit) {
			const nodes = chat?.nodes;
			if (nodes === undefined) return;
			if (nodes instanceof Map) {
				for (const [mapKey, node] of nodes) visit(mapKey, node);
				return;
			}
			if (typeof nodes.values === "function") {
				let index = 0;
				for (const node of nodes.values()) visit(index++, node);
			}
		}

		/**
		 * Map of DOM anchor key -> "let me" match count, built from every
		 * reasoning block of every chat node in the current session snapshot.
		 */
		function computeFlagMap(sessions, currentId) {
			const flags = new Map();
			if (sessions === undefined || currentId === undefined) return flags;
			let binding;
			try {
				binding = sessions.binding(currentId);
			} catch (error) {
				log("binding lookup failed", error);
				return flags;
			}
			const session = binding === undefined || binding === null ? undefined : binding.session;
			if (session === undefined) return flags;
			let snapshot;
			try {
				snapshot = session.getSnapshot();
			} catch (error) {
				log("snapshot read failed", error);
				return flags;
			}
			eachChatNode(snapshot?.chat, (mapKey, node) => {
				const blocks = node?.data?.blocks;
				if (!Array.isArray(blocks)) return;
				let count = 0;
				for (const block of blocks) {
					if (block?.kind !== "reasoning" || typeof block.text !== "string") continue;
					count += matchCount(block.text);
				}
				if (count <= 0) return;
				// The rendered row's anchor key is the node's own key, never the
				// Map/collection key (chat.nodes is a store whose values() yields
				// the nodes; the collection key is only an index). Count each
				// node exactly once under the anchor key.
				const anchorKey = typeof node?.key === "string" ? node.key : mapKey;
				flags.set(anchorKey, (flags.get(anchorKey) ?? 0) + count);
			});
			return flags;
		}

		/** Attach to the current session's snapshot store (idempotent). */
		function attachSession(sessions) {
			if (sessions === undefined) return;
			let currentId;
			try {
				currentId = sessions.list?.getSnapshot().current;
			} catch (error) {
				log("sessions.list read failed", error);
				return;
			}
			if (currentId === lastCurrentId && sessionUnsubscribe !== null) return;
			if (sessionUnsubscribe !== null) {
				sessionUnsubscribe();
				sessionUnsubscribe = null;
			}
			lastCurrentId = currentId;
			if (currentId === undefined) return;
			let binding;
			try {
				binding = sessions.binding(currentId);
			} catch {
				binding = undefined;
			}
			const session = binding === undefined || binding === null ? undefined : binding.session;
			if (session === undefined || typeof session.subscribe !== "function") return;
			sessionUnsubscribe = session.subscribe(scheduleReconcile);
		}

		// ---- DOM reconcile ----
		/**
		 * The "Think" title span: the first direct-child SPAN of the disclosure
		 * row that carries actual text. The leading icon span comes first in the
		 * DOM but has no text, so "first SPAN" alone would put the badge to the
		 * LEFT of the label.
		 */
		function titleSpanOf(row) {
			const disclosure = row.querySelector('[data-disclosure-row]');
			if (disclosure === null) return null;
			for (const child of disclosure.children) {
				if (child.tagName === "SPAN" && (child.textContent ?? "").trim() !== "") return child;
			}
			return null;
		}

		/**
		 * The row's own text, excluding our badge subtree so the badge text
		 * ("出现了 let me") can never match itself. Uses a TreeWalker on real
		 * DOMs; a child walk covers minimal stubs (tests).
		 */
		function domText(row) {
			const badge = row.querySelector(BADGE_SELECTOR);
			if (badge === null) return row.textContent ?? "";
			if (typeof document.createTreeWalker === "function") {
				try {
					const walker = document.createTreeWalker(row, 4 /* NodeFilter.SHOW_TEXT */, {
						acceptNode(node) {
							for (let el = node.parentElement; el !== null && el !== row; el = el.parentElement) {
								if (el === badge) return 2 /* NodeFilter.FILTER_REJECT */;
							}
							return 1 /* NodeFilter.FILTER_ACCEPT */;
						}
					});
					let out = "";
					for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
						out += node.nodeValue ?? "";
					}
					return out;
				} catch {
					// fall through to the naive walk
				}
			}
			let out = "";
			const visit = (node) => {
				for (const child of node.children ?? []) {
					if (child === badge) continue;
					if ((child.children ?? []).length > 0) visit(child);
					else out += child.textContent ?? "";
				}
			};
			visit(row);
			return out;
		}

		/** DOM-text fallback: does this row's own text mention a flagged phrase? */
		function domTextFlagged(row) {
			const text = domText(row);
			for (const pattern of PATTERNS) {
				const clone = new RegExp(pattern.source, pattern.flags.replace(/g/gu, "") + "g");
				if (clone.test(text)) return true;
			}
			return false;
		}

		function labelFor(count) {
			return count > 1 ? `${BADGE_LABEL} ×${count}` : BADGE_LABEL;
		}

		/** Insert the badge right after the Think title span. */
		function insertBadge(row, label) {
			const next = document.createElement("span");
			next.className = "letme-annotator-badge";
			next.setAttribute(BADGE_ATTR, "badge");
			next.textContent = label;
			const title = titleSpanOf(row);
			if (title !== null) title.after(next);
			else row.appendChild(next);
		}

		// ---- position marking (CSS Custom Highlight API) ----
		/**
		 * True when the renderer supports word-level highlighting
		 * (`CSS.highlights` + `Highlight` + `Range`). Otherwise the plugin
		 * falls back to the whole-row red accent bar.
		 */
		const HIGHLIGHTS_OK = typeof CSS !== "undefined"
			&& CSS.highlights !== undefined
			&& typeof Highlight === "function"
			&& typeof document.createRange === "function";
		/** One shared registry entry; rebuilt on every reconcile. */
		let highlight = null;

		function clearHighlights() {
			if (highlight === null) return;
			highlight.clear();
		}

		/** The expanded reasoning body: the non-disclosure DIV child of the DisclosureRow root. */
		function thinkBodyOf(row) {
			const disclosure = row.querySelector('[data-disclosure-row]');
			if (disclosure === null || disclosure.parentElement === null) return null;
			const root = disclosure.parentElement;
			for (const child of root.children) {
				if (child !== disclosure && child.tagName === "DIV") return child;
			}
			return null;
		}

		/** Add a red range around every pattern match in the given subtree. */
		function addHighlightsIn(root) {
			if (highlight === null || typeof document.createTreeWalker !== "function") return;
			const textNodes = [];
			try {
				const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null);
				for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) textNodes.push(node);
			} catch {
				return;
			}
			for (const textNode of textNodes) {
				const text = textNode.nodeValue ?? "";
				for (const pattern of PATTERNS) {
					const re = new RegExp(pattern.source, pattern.flags.replace(/g/gu, "") + "g");
					for (let match = re.exec(text); match !== null; match = re.exec(text)) {
						if (match[0].length === 0) continue;
						try {
							const range = document.createRange();
							range.setStart(textNode, match.index);
							range.setEnd(textNode, match.index + match[0].length);
							highlight.add(range);
						} catch {
							// range over a detached/odd node: skip this match
						}
					}
				}
			}
		}

		/**
		 * Mark every visible occurrence of a flagged phrase at its exact
		 * position: the collapsed summary line and/or the expanded reasoning
		 * body. Only ever applied to rows that are flagged.
		 */
		function addRowHighlights(row) {
			const disclosure = row.querySelector('[data-disclosure-row]');
			if (disclosure !== null) {
				// collapsed summary = the last direct-child SPAN with text
				let summary = null;
				for (const child of disclosure.children) {
					if (child.tagName === "SPAN" && (child.textContent ?? "").trim() !== "") summary = child;
				}
				if (summary !== null) addHighlightsIn(summary);
			}
			const body = thinkBodyOf(row);
			if (body !== null) addHighlightsIn(body);
		}

		/**
		 * Idempotent row sync: mutate the DOM only when the rendered state
		 * differs from the desired state. Reconcile must not touch the DOM
		 * when nothing changed — otherwise every run's own mutations re-trigger
		 * the MutationObserver, which re-schedules reconcile, which mutates
		 * again… an infinite microtask loop that freezes the renderer.
		 * @returns whether the row is flagged (badge shown).
		 */
		function applyRowState(row, count) {
			const badge = row.querySelector(BADGE_SELECTOR);
			if (count > 0) {
				// Whole-row accent only in fallback mode; otherwise the exact
				// positions are marked by the Custom Highlight.
				if (!HIGHLIGHTS_OK && row.getAttribute(FLAG_ATTR) !== "true") row.setAttribute(FLAG_ATTR, "true");
				const label = labelFor(count);
				if (badge === null) insertBadge(row, label);
				else if (badge.textContent !== label) badge.textContent = label;
				return true;
			}
			if (domTextFlagged(row)) {
				if (!HIGHLIGHTS_OK && row.getAttribute(FLAG_ATTR) !== "true") row.setAttribute(FLAG_ATTR, "true");
				if (badge === null) insertBadge(row, labelFor(1));
				return true;
			}
			if (row.getAttribute(FLAG_ATTR) === "true") row.removeAttribute(FLAG_ATTR);
			if (badge !== null) badge.remove();
			return false;
		}

		function reconcile() {
			const sessions = currentSessions();
			attachSession(sessions);
			clearHighlights();
			const rows = document.querySelectorAll(THINK_SELECTOR);
			if (rows.length === 0) return; // nothing to annotate: skip the snapshot scan
			const flags = computeFlagMap(sessions, lastCurrentId);
			for (const row of rows) {
				const anchor = row.closest('[data-chat-anchor-key]');
				const key = anchor === null ? null : anchor.getAttribute("data-chat-anchor-key");
				const count = key !== null && flags.has(key) ? (flags.get(key) ?? 0) : 0;
				if (applyRowState(row, count) && HIGHLIGHTS_OK) addRowHighlights(row);
			}
		}

		/** Resolve the sessions service defensively (ordering-safe). */
		function currentSessions() {
			try {
				const ctxSessions = ctxRef;
				if (ctxSessions === undefined) return undefined;
				if (typeof ctxSessions.get === "function") {
					const viaGet = ctxSessions.get("sessions");
					if (viaGet !== undefined && viaGet !== null) return viaGet;
				}
				return ctxSessions.sessions;
			} catch {
				return undefined;
			}
		}

		// ---- plugin entry ----
		/** Services required by the browser half. */
		const inject = ["sessions"];
		/** Module-level ctx captured by apply (the facade denies property reads otherwise). */
		let ctxRef;

		/**
		 * Client plugin body: install the style sheet, subscribe to session and
		 * DOM changes, and keep the badges reconciled. All subscriptions ride
		 * `ctx.effect`, so plugin unload tears everything down.
		 */
		function apply(ctx) {
			ctxRef = ctx;
			ctx.effect(() => {
				ensureStyles();
				if (HIGHLIGHTS_OK) {
					highlight = new Highlight();
					CSS.highlights.set(HIGHLIGHT_NAME, highlight);
				}
				const sessions = currentSessions();
				let unsubList = () => {};
				if (sessions !== undefined && sessions.list !== undefined && typeof sessions.list.subscribe === "function") {
					unsubList = sessions.list.subscribe(scheduleReconcile);
				}
				let observer = null;
				if (typeof MutationObserver === "function") {
					observer = new MutationObserver(scheduleReconcile);
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						characterData: true
					});
				}
				scheduleReconcile();
				return () => {
					unsubList();
					if (observer !== null) observer.disconnect();
					if (sessionUnsubscribe !== null) {
						sessionUnsubscribe();
						sessionUnsubscribe = null;
					}
					if (highlight !== null) {
						highlight.clear();
						if (typeof CSS !== "undefined" && CSS.highlights !== undefined) CSS.highlights.delete(HIGHLIGHT_NAME);
						highlight = null;
					}
					for (const badge of document.querySelectorAll(BADGE_SELECTOR)) badge.remove();
					for (const row of document.querySelectorAll(THINK_SELECTOR)) row.removeAttribute(FLAG_ATTR);
					const style = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
					if (style !== null) style.remove();
					ctxRef = undefined;
				};
			}, "letme-annotator: badge reconcile");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
