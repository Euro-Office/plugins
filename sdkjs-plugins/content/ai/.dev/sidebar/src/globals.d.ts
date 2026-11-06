// SPDX-License-Identifier: AGPL-3.0-only
//
// Globals provided by the scripts that sidebar/index.html loads before the
// bundle: the plugin SDK (plugins.js), markdown-it (vendor/md), and the
// plugin's own helpers (agentHistory.js, citations.js, chatVoice.js, theme.js).

export interface Theme {
	type?: string;
	name?: string;
	[key: string]: unknown;
}

export interface PluginApi {
	tr(text: string): string;
	attachEvent(name: string, handler: (data: any) => void): void;
	sendToPlugin(name: string, data?: unknown): void;
	guid?: string;
	info?: { editorType?: string; userName?: string; lang?: string };
	init?: () => void;
	onTranslate?: () => void;
	onThemeChanged?: (theme: Theme) => void;
	onThemeChangedBase?: (theme: Theme) => void;
}

export interface EOLocation {
	editor: string;
	type: string;
	[key: string]: unknown;
}

export interface VoiceEngine {
	engine: { start(): void; stop(): void };
	onStart?: () => void;
	onEnd?: () => void;
	onProgress?: (text: string) => void;
	onError?: (error: string) => void;
}

interface MarkdownIt {
	render(src: string): string;
	validateLink(url: string): boolean;
	renderer: { rules: Record<string, (tokens: { content: string }[], idx: number) => string> };
	utils: { escapeHtml(text: string): string };
}

declare global {
	interface Window {
		Asc: { plugin: PluginApi; OpenAIEncode?: (text: string) => unknown[] };
		markdownit(options?: object): MarkdownIt;
		AgentHistory: {
			build(items: object[]): object[];
			collectToolNames(items: object[]): string[];
			compactTranscript(messages: object[]): object[];
			pruneTranscripts(items: object[]): void;
		};
		EOLinks: {
			parse(href: string): EOLocation | null;
			describe(loc: EOLocation, tr?: (s: string) => string): string;
			isLocationHref(href: string): boolean;
		};
		initVoiceRecognitionEngine?: () => VoiceEngine | null;
		updateBodyThemeClasses?: (type?: string, name?: string) => void;
		updateThemeVariables?: (theme: Theme) => void;
	}
}
