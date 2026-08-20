/**
 * One-off repro: does lib/client.js enter a runaway reconcile loop once a
 * "let me" match exists, under real-browser MutationObserver semantics?
 *
 * The fake DOM here notifies the plugin's MutationObserver on every mutation
 * (appendChild/after/remove/setAttribute/removeAttribute/textContent), like a
 * real browser does. Run with:  node test/repro-loop.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- fake DOM with observer notifications ----------
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
			notify();
			return child;
		},
		after(next) {
			children.push(next);
			next.parent = this;
			notify();
			return next;
		},
		remove() {
			if (this.parent !== null) {
				const siblings = this.parent.children;
				const index = siblings.indexOf(this);
				if (index !== -1) siblings.splice(index, 1);
			}
			this.removed = true;
			notify();
		},
		setAttribute(name, value) {
			const prev = this.attributes.get(name);
			this.attributes.set(name, String(value));
			if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
			if (prev !== String(value)) notify();
		},
		getAttribute(name) {
			return this.attributes.has(name) ? this.attributes.get(name) : null;
		},
		removeAttribute(name) {
			const had = this.attributes.delete(name);
			if (name.startsWith("data-")) delete this.dataset[name.slice(5)];
			if (had) notify();
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
				notify();
			}
		},
		configurable: true
	});
	return el;
}

let mutationCount = 0;
let observerCallback = null;
function notify() {
	mutationCount += 1;
	if (observerCallback !== null) observerCallback();
}

function buildThinkRow(anchorKey, summaryText) {
	const row = fakeElement("div", { attributes: { "data-variant": "think" } });
	row.anchor = fakeElement("div", { attributes: { "data-chat-anchor-key": anchorKey } });
	const disclosure = fakeElement("div", { attributes: { "data-disclosure-row": "" } });
	disclosure.appendChild(fakeElement("button"));
	disclosure.appendChild(fakeElement("span", { textContent: "Think" }));
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
globalThis.window = {
	__ModuleLoader__: {
		load(decl) {
			captured = decl;
		}
	}
};
globalThis.document = documentStub;

let captured = null;
let snapshot = null;
let sessionSub = null;
let listSub = null;
const sessionStub = {
	getSnapshot: () => snapshot,
	subscribe: (fn) => {
		sessionSub = fn;
		return () => {
			sessionSub = null;
		};
	}
};
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

const source = readFileSync(join(root, "lib", "client.js"), "utf8");
eval(source);
const mod = captured.factory(() => {
	throw new Error("bundle must not require anything");
});

rows = [buildThinkRow("node-1", "Let me think about this.")];
snapshot = {
	chat: {
		nodes: new Map([["node-1", {
			key: "node-1",
			kind: "assistant-step",
			data: { blocks: [{ kind: "reasoning", text: "Let me think about this." }] }
		}]])
	}
};

mod.apply(ctx);

const startedAt = Date.now();
const settleTicks = 20;
for (let i = 0; i < settleTicks; i += 1) {
	await new Promise((resolve) => setTimeout(resolve, 0));
	if (Date.now() - startedAt > 5000) {
		console.error(`FAIL - runaway reconcile loop suspected (mutations: ${mutationCount}, reconcile still rescheduling after ${i} ticks)`);
		process.exit(1);
	}
}

const before = mutationCount;
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
const after = mutationCount;
const badge = rows[0].querySelector('[data-letme-annotator="badge"]');

console.log(`mutations during settle window: ${before} -> ${after}`);
console.log(`badge present: ${badge !== null}`);

if (after !== before) {
	console.error("FAIL - reconcile keeps mutating forever (infinite loop)");
	process.exit(1);
}
console.log("OK - reconcile settled (no infinite loop)");
process.exit(0);
