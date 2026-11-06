// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport of scripts/engine/engine.js: requestWrapper and
// requestWrapperStream with and without the Document Server AI proxy.

import { test, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { createSandbox, readPluginFile, pluginPath } from "../lib/sandbox.js";

const ENGINE = "scripts/engine/engine.js";
const ending = "})(window);";
const source = readPluginFile(ENGINE);
// Expose the private transport functions in the sandbox without changing the shipped API.
const testSource = source.slice(0, source.lastIndexOf(ending)) +
	"window.transport = {requestWrapper, requestWrapperStream};" + ending;

const target = "https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent";
const proxy = "https://editor.example/ai-proxy";
const publicProxy = "https://public.example/proxy";

function loadEngine(settings = { proxy }, response = new Response("first chunk")) {
	const calls = [];
	const sb = createSandbox({
		AI: { serverSettings: settings },
		Asc: { plugin: { info: { jwt: "test-session-token" } } },
		fetch: async (url, request) => {
			calls.push({ url, request });
			return response;
		}
	});
	sb.run(testSource, pathToFileURL(pluginPath(ENGINE)).href);
	sb.ctx.AI.PROXY_URL = publicProxy;
	return { transport: sb.ctx.transport, calls };
}

function message(overrides = {}) {
	return {
		url: target,
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Provider-Header": "provider-value" },
		body: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
		isUseProxy: true,
		...overrides
	};
}

test("server-configured streaming uses the authenticated proxy and preserves the provider request", async () => {
	const { transport, calls } = loadEngine();
	const input = message();
	await transport.requestWrapperStream(input);
	expect(calls).toHaveLength(1);
	const { url, request } = calls[0];
	expect(url).toBe(proxy);
	expect(request.headers.Authorization).toBe("Bearer test-session-token");
	expect(request.headers["X-Provider-Header"]).toBeUndefined();
	expect(request.method).toBe("POST");
	expect(JSON.parse(request.body)).toEqual({
		target, method: "POST", headers: input.headers, data: JSON.stringify(input.body)
	});
	expect(request.signal).toBeInstanceOf(AbortSignal);
});

test("streaming and non-streaming use the same server proxy envelope", async () => {
	const streaming = loadEngine();
	const regular = loadEngine({ proxy }, new Response("{\"answer\":\"ok\"}"));
	await streaming.transport.requestWrapperStream(message());
	const result = await regular.transport.requestWrapper(message());
	expect(result.error).toBe(0);
	expect(streaming.calls[0].url).toBe(regular.calls[0].url);
	expect(streaming.calls[0].request.body).toBe(regular.calls[0].request.body);
	expect(streaming.calls[0].request.headers.Authorization).toBe(regular.calls[0].request.headers.Authorization);
});

test("without server settings, proxied streaming goes to the public proxy without a session token", async () => {
	const { transport, calls } = loadEngine(null);
	const input = message();
	await transport.requestWrapperStream(input);
	expect(calls[0].url).toBe(publicProxy);
	expect(calls[0].request.headers).toBeUndefined();
	expect(JSON.parse(calls[0].request.body)).toEqual({
		target, method: "POST", headers: input.headers, data: JSON.stringify(input.body)
	});
	expect(calls[0].request.signal).toBeInstanceOf(AbortSignal);
});

test("proxied streaming delivers chunks before completion and preserves split UTF-8", async () => {
	let controller;
	const stream = new ReadableStream({ start(c) { controller = c; } });
	const { transport } = loadEngine({ proxy }, new Response(stream));
	const reader = await transport.requestWrapperStream(message());
	const bytes = new TextEncoder().encode("Привет");
	controller.enqueue(bytes.slice(0, 3));
	const first = await reader.read();
	expect(first.done).toBe(false);
	expect(first.value).toBe("П");
	controller.enqueue(bytes.slice(3));
	expect((await reader.read()).value).toBe("ривет");
	controller.close();
	expect((await reader.read()).done).toBe(true);
});

test("abort cancels both the proxy fetch signal and the response reader", async () => {
	let cancelled = false;
	const stream = new ReadableStream({ cancel() { cancelled = true; } });
	const { transport, calls } = loadEngine({ proxy }, new Response(stream));
	const reader = await transport.requestWrapperStream(message());
	await reader.abort();
	expect(calls[0].request.signal.aborted).toBe(true);
	expect(cancelled).toBe(true);
	expect((await reader.read()).done).toBe(true);
});

test("provider errors remain readable through the proxy", async () => {
	const error = "{\"error\":{\"message\":\"Provider quota exceeded\"}}";
	const { transport } = loadEngine({ proxy }, new Response(error, { status: 429 }));
	const reader = await transport.requestWrapperStream(message());
	expect((await reader.read()).value).toBe(error);
});

// A browser-configured provider only proxies when the provider asks for it
// (AI._extendBody), so without server settings isUseProxy is false.
test.each([
	["browser-configured provider", null, { isUseProxy: false }],
	["request that opts out of proxying", { proxy }, { isUseProxy: false }],
	["GET request", { proxy }, { method: "GET" }]
])("%s retains direct streaming without a session token", async (_name, settings, overrides) => {
	const { transport, calls } = loadEngine(settings);
	const input = message(overrides);
	await transport.requestWrapperStream(input);
	expect(calls[0].url).toBe(target);
	expect(calls[0].request.headers).toEqual(input.headers);
	expect(calls[0].request.headers.Authorization).toBeUndefined();
	if (input.method === "GET")
		expect(calls[0].request.body).toBeUndefined();
	else
		expect(calls[0].request.body).toBe(JSON.stringify(input.body));
});
