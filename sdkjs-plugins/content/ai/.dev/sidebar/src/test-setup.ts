// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Loads the plain scripts that sidebar/index.html loads before the bundle
// (markdown-it, agentHistory.js, citations.js) into the jsdom window.
import fs from "node:fs";
import path from "node:path";

const PLUGIN_DIR = path.resolve(__dirname, "../../..");

for (const file of ["vendor/md/markdown-it.js", "scripts/helpers/agentHistory.js", "scripts/helpers/citations.js"]) {
	(0, eval)(fs.readFileSync(path.join(PLUGIN_DIR, file), "utf8"));
}
const g = globalThis as any;
window.markdownit = window.markdownit || g.markdownit;
window.AgentHistory = window.AgentHistory || g.AgentHistory;
window.EOLinks = window.EOLinks || g.EOLinks;

// Node 22+ has its own (disabled) localStorage global that hides jsdom's.
class MemoryStorage {
	private map = new Map<string, string>();
	get length() { return this.map.size; }
	key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
	getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
	setItem(k: string, v: string) { this.map.set(k, String(v)); }
	removeItem(k: string) { this.map.delete(k); }
	clear() { this.map.clear(); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
