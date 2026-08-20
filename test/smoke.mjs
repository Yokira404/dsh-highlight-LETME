/**
 * Smoke test for dsh-plugin-letme-annotator's browser half.
 *
 * Evaluates lib/client.js against stubbed browser + session surfaces and
 * asserts the badge behavior end to end. The fake DOM notifies the plugin's
 * MutationObserver on every mutation — exactly like a real browser — so the
 * tests also catch the runaway-reconcile freeze regression (badge remove/
 * insert ping-pong that never settles). Run with:  node test/smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- minimal fake DOM ----------
/** Hard cap: a healthy plugin mutates a handful of times per scenario.
 *  An infinite reconcile loop blows past this, failing the test instead of
 *  hanging it. */
const MUTATION_CAP = 5000;
let mutationCount = 0;
let observerCallback = null;

/** Real browsers deliver MutationObserver records for DOM mutations; the
 *  plugin's observer must never be re-triggered by its own settled state. */
function notifyMutation() {
	mutationCount += 1;
	if (mutationCount > MUTATION_CAP) {
		throw new Error(`runaway DOM mutation loop (${mutationCount} mutations) — reconcile keeps rewriting the DOM`);
	}
	if (observerCallback !== null) observerCallback();
}

function matchesSelector(el, sel) {
	if (sel.startsWith("[")) {
		const inner = sel.slice(1, -1);
		const eq = inner.indexOf("=");
		if (eq === -1) return el.attributes.has(inner);
		const name = inner.slice(0, eq);
		const value = inner.slice(eq + 1).replace(/^"|"$/g, "");
		return el.attributes.has(name) && el.attributes.get(name) === value;
	}
	return el.tagName === sel.toUpperCase();
}

function fakeElement(tagName, attrs = {}) {
	const children = [];
	let text = attrs.textContent ?? undefined;
	const el = {
		tagName: String(tagName).toUpperCase(),
		children,
		className: "",
		attributes: new Map(Object.entries(attrs.attributes ?? {})),
		dataset: {},
		parent: null,
		appendChild(child) {
			children.push(child);
			child.parent = this;
			notifyMutation();
			return child;
		},
		after(next) {
			children.push(next);
			next.parent = this;
			notifyMutation();
			return next;
		},
		remove() {
			if (this.parent !== null) {
				const siblings = this.parent.children;
				const index = siblings.indexOf(this);
				if (index !== -1) siblings.splice(index, 1);
			}
			this.removed = true;
			notifyMutation();
		},
		setAttribute(name, value) {
			const previous = this.attributes.get(name);
			this.attributes.set(name, String(value));
			if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
			if (previous !== String(value)) notifyMutation();
		},
		getAttribute(name) {
			return this.attributes.has(name) ? this.attributes.get(name) : null;
		},
		removeAttribute(name) {
			const had = this.attributes.delete(name);
			if (name.startsWith("data-")) delete this.dataset[name.slice(5)];
			if (had) notifyMutation();
		},
		querySelector(sel) {
			const visit = (node) => {
				for (const child of node.children) {
					if (matchesSelector(child, sel)) return child;
					const found = visit(child);
					if (found !== null) return found;
				}
				return null;
			};
			return visit(this);
		},
		closest() {
			return this.anchor ?? null;
		}
	};
	Object.defineProperty(el, "textContent", {
		get() {
			if (text !== undefined) return text;
			return children.map((child) => child.textContent ?? "").join("");
		},
		set(value) {
			const next = String(value);
			if (text !== next) {
				text = next;
				notifyMutation();
			}
		},
		configurable: true
	});
	return el;
}

// Build the Think row DOM: row[data-variant=think] > disclosure[data-disclosure-row] > [button, span.title, span.summary]
function buildThinkRow(anchorKey, summaryText) {
	const row = fakeElement("div", { attributes: { "data-variant": "think" } });
	row.anchor = fakeElement("div", { attributes: { "data-chat-anchor-key": anchorKey } });
	const disclosure = fakeElement("div", { attributes: { "data-disclosure-row": "" } });
	row.disclosure = disclosure;
	disclosure.appendChild(fakeElement("button"));
	const title = fakeElement("span", { textContent: "Think" });
	disclosure.appendChild(title);
	// real ReasoningRow renders a separator dot between the title and the summary
	disclosure.appendChild(fakeElement("span", { textContent: "·" }));
	disclosure.appendChild(fakeElement("span", { textContent: summaryText }));
	row.appendChild(disclosure);
	return row;
}

let rows = [];
const documentStub = {
	head: fakeElement("head"),
	body: fakeElement("body"),
	querySelector() {
		return null;
	},
	querySelectorAll(sel) {
		if (sel === '[data-variant="think"]') return [...rows];
		if (sel === '[data-letme-annotator="badge"]') {
			const badges = [];
			for (const row of rows) {
				const badge = row.querySelector(sel);
				if (badge !== null) badges.push(badge);
			}
			return badges;
		}
		return [];
	},
	createElement(tag) {
		return fakeElement(tag);
	}
};

globalThis.MutationObserver = class {
	constructor(cb) {
		observerCallback = cb;
	}
	observe() {}
	disconnect() {
		observerCallback = null;
	}
};
let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load(decl) {
			captured = decl;
		}
	}
};
globalThis.document = documentStub;

// ---------- session stubs ----------
let snapshot = null;
let sessionSub = null;
let listSub = null;
const sessionsStub = {
	list: {
		getSnapshot: () => ({ current: "s1" }),
		subscribe: (fn) => {
			listSub = fn;
			return () => {
				listSub = null;
			};
		}
	},
	binding: () => ({ session: sessionStub })
};
const sessionStub = {
	getSnapshot: () => snapshot,
	subscribe: (fn) => {
		sessionSub = fn;
		return () => {
			sessionSub = null;
		};
	}
};

function makeSnapshot(reasoningText) {
	const node = {
		key: "node-1",
		kind: "assistant-step",
		data: {
			blocks: reasoningText === null ? [] : [{ kind: "reasoning", text: reasoningText }]
		}
	};
	return { chat: { nodes: new Map([["node-1", node]]) } };
}

const ctx = {
	get: (name) => (name === "sessions" ? sessionsStub : undefined),
	sessions: sessionsStub,
	disposer: null,
	effect(callback) {
		const cleanup = callback();
		this.disposer = cleanup;
		return cleanup;
	}
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------- test harness ----------
let failures = 0;
function assert(condition, message) {
	if (condition) {
		console.log(`  ok - ${message}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

async function main() {
	const source = readFileSync(join(root, "lib", "client.js"), "utf8");
	eval(source);
	if (captured === null || captured.id !== "dsh-plugin-letme-annotator") {
		console.error("FAIL - bundle did not register via __ModuleLoader__.load");
		process.exit(1);
	}
	const factory = captured.factory;
	const mod = factory(() => {
		throw new Error("bundle must not require anything");
	});
	assert(typeof mod.apply === "function", "bundle exports apply");
	assert(Array.isArray(mod.inject) && mod.inject.includes("sessions"), "bundle exports inject with sessions");

	// --- scenario 1: reasoning contains "let me" -> badge appears next to Think ---
	rows = [buildThinkRow("node-1", "Let me think about this.")];
	snapshot = makeSnapshot("Let me think about this carefully.\nSecond line.");
	mod.apply(ctx);
	await tick();
	{
		const row = rows[0];
		const badge = row.querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null, "badge inserted for reasoning containing 'let me'");
		assert(badge !== null && badge.textContent === "出现了 let me", `badge label is "出现了 let me" (got: ${badge?.textContent})`);
		assert(row.attributes.has("data-letme-flagged"), "row flagged with data-letme-flagged");
		const title = row.querySelector('[data-disclosure-row]').children[1];
		assert(title !== null && title.tagName === "SPAN", "badge placed next to the Think title span");
	}

	// --- scenario 2: text updates and no longer matches -> badge removed ---
	snapshot = makeSnapshot("No phrase here.");
	rows = [buildThinkRow("node-1", "No phrase here.")]; // React re-renders the summary to match
	sessionSub();
	await tick();
	{
		const row = rows[0];
		assert(row.querySelector('[data-letme-annotator="badge"]') === null, "badge removed when 'let me' disappears");
		assert(!row.attributes.has("data-letme-flagged"), "row un-flagged when 'let me' disappears");
	}

	// --- scenario 3: multiple occurrences -> count suffix ---
	snapshot = makeSnapshot("Let me check. And let me verify again.");
	sessionSub();
	await tick();
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null && badge.textContent === "出现了 let me ×2", `count suffix shown (got: ${badge?.textContent})`);
	}

	// --- scenario 4: case-insensitive ---
	snapshot = makeSnapshot("LET ME stop.");
	sessionSub();
	await tick();
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null && badge.textContent === "出现了 let me", "case-insensitive match flagged");
	}

	// --- scenario 4b: store-shaped snapshot nodes count once (regression) ---
	// The real session snapshot exposes chat.nodes as a store whose values()
	// yields the nodes; the collection key is just an index. The rendered
	// anchor key is the node's own key, and each node's occurrences must be
	// counted exactly once (they used to be doubled).
	rows = [buildThinkRow("step-1", "Let me check. And let me verify again.")];
	snapshot = {
		chat: {
			nodes: {
				values: () => [{
					key: "step-1",
					kind: "assistant-step",
					data: { blocks: [{ kind: "reasoning", text: "Let me check. And let me verify again." }] }
				}]
			}
		}
	};
	sessionSub();
	await tick();
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null && badge.textContent === "出现了 let me ×2", `store-shaped snapshot counts once (got: ${badge?.textContent})`);
	}

	// --- scenario 5: snapshot unreachable -> DOM text fallback still flags ---
	snapshot = { chat: { nodes: new Map() } };
	sessionSub();
	rows = [buildThinkRow("node-9", "Let me recall the first line only.")];
	snapshot = makeSnapshot(null);
	sessionSub();
	await tick();
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null, "DOM-text fallback flags a row whose snapshot node is absent");
	}

	// --- scenario 6: collapsed row with match only on later line (summary clean) ---
	rows = [buildThinkRow("node-1", "First line is innocent.")];
	snapshot = makeSnapshot("First line is innocent.\nBut later I say: let me switch gears.");
	sessionSub();
	await tick();
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null, "match on a non-first line flagged via snapshot (collapsed row)");
	}

	// --- scenario 7: reconcile settles (regression: runaway mutation loop) ---
	// With a live match the badge is present and correct. A frozen app is what
	// happens when reconcile keeps removing/re-inserting the badge forever:
	// every mutation re-triggers the observer, which re-schedules reconcile.
	// The DOM must be untouched once the state is stable.
	{
		const badge = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badge !== null && badge.textContent === "出现了 let me", "badge present before settle check");
		const settledAt = mutationCount;
		await tick();
		await tick();
		await tick();
		assert(mutationCount === settledAt, "no DOM mutations once the badge state is stable (no reconcile loop)");
		const badgeAfter = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(badgeAfter !== null && badgeAfter.textContent === "出现了 let me", "badge survives the settle window");
	}

	// --- scenario 8: cleanup removes badges and styles on unload ---
	{
		const before = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(before !== null, "badge present before unload");
		ctx.disposer();
		await tick();
		const after = rows[0].querySelector('[data-letme-annotator="badge"]');
		assert(after === null, "badge removed by effect cleanup");
		assert(!rows[0].attributes.has("data-letme-flagged"), "row un-flagged by effect cleanup");
		assert(sessionSub === null, "session subscription released by cleanup");
	}

	if (failures === 0) {
		console.log("\nAll smoke tests passed.");
		process.exit(0);
	} else {
		console.error(`\n${failures} assertion(s) failed.`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("smoke test crashed:", error);
	process.exit(1);
});
