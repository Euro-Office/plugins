// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Markdown of chat answers (vendored markdown-it, raw HTML disabled).
// Only http(s), mailto and eo:// links become links; anything else stays
// text. Valid eo:// locations (citations.js) become location chips, invalid
// ones are replaced by their text.

let md: ReturnType<Window["markdownit"]> | null = null;

export const ALLOWED_LINK = /^(https?:|mailto:|eo:)/i;

function getMarkdown() {
	if (!md) {
		md = window.markdownit();
		md.validateLink = (url: string) => ALLOWED_LINK.test(url.trim());
		// Images would load without a click, so model output (or a prompt injected
		// through document content) could send data to any host. Show the alt text.
		md.renderer.rules.image = (tokens, idx) => md!.utils.escapeHtml(tokens[idx].content || "");
	}
	return md;
}

export interface Rendered {
	html: string;
	text: string;
}

// streaming: some models glue a heading to a rule ("---#"); markdown-it
// would render that as text until the next line arrives.
export function renderMarkdown(source: string, tr: (s: string) => string, streaming = false): Rendered {
	let text = streaming ? source.replace(/\n---#/g, "\n---\n#") : source;
	let tpl = document.createElement("template");
	tpl.innerHTML = getMarkdown().render(text);
	tpl.content.querySelectorAll("a").forEach((a) => {
		let href = a.getAttribute("href") || "";
		if (!window.EOLinks.isLocationHref(href))
			return;
		let loc = window.EOLinks.parse(href);
		if (!loc) {
			a.replaceWith(document.createTextNode(a.textContent || ""));
			return;
		}
		a.classList.add("eo_location_link");
		a.setAttribute("role", "button");
		a.setAttribute("title", tr("Go to location") + ": " + window.EOLinks.describe(loc, tr));
	});
	return { html: tpl.innerHTML, text: (tpl.content.textContent || "").replace(/\n{3,}/g, "\n\n") };
}

// Location links only make sense in the chat: copied and inserted text
// keeps their label, not the eo:// link.
export function stripLocationLinksMarkdown(markdown: string): string {
	return String(markdown || "").replace(/\[([^\]]*)\]\(\s*<?eo:[^)\s>]*>?\s*\)/gi, "$1");
}

export function stripLocationLinksHtml(html: string): string {
	return String(html || "").replace(/<a\s[^>]*href="eo:[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, "$1");
}
