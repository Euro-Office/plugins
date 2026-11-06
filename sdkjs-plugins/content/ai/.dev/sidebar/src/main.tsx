// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Entry of the chat sidebar (sidebar/index.html).

import { render } from "preact";
import { App } from "./App";
import { createChat } from "./chat";
import type { PluginApi } from "./globals";
import "./styles.css";

// The SDK loads translations from "./translations/" next to the page, which
// is sidebar/translations/ here, so the plugin's files are loaded from the
// parent folder instead. XMLHttpRequest also works from file:// (desktop).
function getJSON(url: string): Promise<any> {
	return new Promise((resolve) => {
		let xhr = new XMLHttpRequest();
		xhr.open("GET", url);
		xhr.onload = () => {
			try {
				resolve(JSON.parse(xhr.responseText));
			} catch (e) {
				resolve(null);
			}
		};
		xhr.onerror = () => resolve(null);
		xhr.send();
	});
}

export async function loadTranslations(lang: string | undefined): Promise<Record<string, string> | null> {
	if (!lang || /^en(-|$)/.test(lang))
		return null;
	let langs: string[] = (await getJSON("../translations/langs.json")) || [];
	let file = langs.find((l) => l === lang) || langs.find((l) => l.split("-")[0] === lang.split("-")[0]);
	return file ? getJSON("../translations/" + file + ".json") : null;
}

// The SDK reads the plugin GUID from "./config.json" next to the page, which
// does not exist in sidebar/. Without it the editor ignores the page, so it
// is set here (checked against config.json by the tests).
export const PLUGIN_GUID = "asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}";

// The chat panel is created closed (0×0) at startup: tell the plugin when
// it is shown or hidden, so selection suggestions only run while visible.
// Collapsing the panel or switching to another right pane hides an ancestor
// of the frame (display: none) without resizing it, so the frame size alone
// is not enough: an IntersectionObserver sees it.
function reportVisibility(plugin: PluginApi, root: HTMLElement) {
	let last: boolean | null = null;
	let intersecting = true;
	let report = () => {
		let visible = intersecting && window.innerWidth > 0 && window.innerHeight > 0;
		if (visible !== last)
			plugin.sendToPlugin("onChatVisible", (last = visible));
	};
	report();
	window.addEventListener("resize", report);
	if (typeof IntersectionObserver === "function") {
		new IntersectionObserver((entries) => {
			intersecting = entries[entries.length - 1].isIntersecting;
			report();
		}).observe(root);
	}
}

export function start(plugin: PluginApi, root: HTMLElement, storage?: Storage) {
	if (!plugin.guid || plugin.guid === "undefined")
		plugin.guid = PLUGIN_GUID;
	let chat = createChat(plugin, storage);
	chat.attach();
	plugin.onThemeChanged = (theme) => {
		chat.handlers.onThemeChanged(theme);
		chat.changed();
	};
	plugin.onTranslate = () => {
		chat.state.trVersion++;
		chat.changed();
	};
	plugin.init = () => {
		chat.restore();
		render(<App chat={chat} />, root);
		plugin.sendToPlugin("onWindowReady", {});
		reportVisibility(plugin, root);
		loadTranslations(plugin.info && plugin.info.lang).then((map) => map && chat.setTranslations(map));
	};
	return chat;
}

if (typeof window !== "undefined" && window.Asc && window.Asc.plugin && document.getElementById("root"))
	start(window.Asc.plugin, document.getElementById("root")!);
