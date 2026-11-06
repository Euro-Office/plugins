// SPDX-FileCopyrightText: 2026 Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Run with: node --test sdkjs-plugins/content/ai/.dev/tests/stream-proxy.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/engine/engine.js'), 'utf8');
const ending = '})(window);';
assert.ok(source.trimEnd().endsWith(ending));
// Expose private transport functions in an isolated context without changing the shipped API.
const testSource = source.slice(0, source.lastIndexOf(ending)) +
    'window.transport = {requestWrapper, requestWrapperStream};' + ending;
const target = 'https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent';
const proxy = 'https://editor.example/ai-proxy';

function loadEngine(settings = {proxy}, response = new Response('first chunk')) {
    const calls = [];
    const window = {};
    const context = {
        window,
        AI: {serverSettings: settings},
        Asc: {plugin: {info: {jwt: 'test-session-token'}}},
        AbortController, TextDecoder,
        fetch: async (url, request) => {
            calls.push({url, request});
            return response;
        }
    };
    vm.runInNewContext(testSource, context, {filename: 'engine.js'});
    return {transport: window.transport, calls};
}

function message(overrides = {}) {
    return {
        url: target,
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Provider-Header': 'provider-value'},
        body: {contents: [{role: 'user', parts: [{text: 'Hello'}]}]},
        isUseProxy: true,
        ...overrides
    };
}

test('server-configured streaming uses the authenticated proxy and preserves provider request', async () => {
    const {transport, calls} = loadEngine();
    const input = message();
    await transport.requestWrapperStream(input);
    assert.equal(calls.length, 1);
    const {url, request} = calls[0];
    assert.equal(url, proxy);
    assert.equal(request.headers.Authorization, 'Bearer test-session-token');
    assert.equal(request.headers['X-Provider-Header'], undefined);
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), {
        target, method: 'POST', headers: input.headers, data: JSON.stringify(input.body)
    });
    assert.ok(request.signal instanceof AbortSignal);
});

test('streaming and non-streaming use the same server proxy envelope', async () => {
    const streaming = loadEngine();
    const regular = loadEngine({proxy}, new Response('{"answer":"ok"}'));
    await streaming.transport.requestWrapperStream(message());
    const result = await regular.transport.requestWrapper(message());
    assert.equal(result.error, 0);
    assert.equal(streaming.calls[0].url, regular.calls[0].url);
    assert.equal(streaming.calls[0].request.body, regular.calls[0].request.body);
    assert.equal(streaming.calls[0].request.headers.Authorization,
        regular.calls[0].request.headers.Authorization);
});

test('proxied streaming delivers chunks before completion and preserves split UTF-8', async () => {
    let controller;
    const stream = new ReadableStream({start(c) {controller = c;}});
    const {transport} = loadEngine({proxy}, new Response(stream));
    const reader = await transport.requestWrapperStream(message());
    const bytes = new TextEncoder().encode('Привет');
    controller.enqueue(bytes.slice(0, 3));
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(first.value, 'П');
    controller.enqueue(bytes.slice(3));
    assert.equal((await reader.read()).value, 'ривет');
    controller.close();
    assert.equal((await reader.read()).done, true);
});

test('abort cancels both the proxy fetch signal and response reader', async () => {
    let cancelled = false;
    const stream = new ReadableStream({cancel() {cancelled = true;}});
    const {transport, calls} = loadEngine({proxy}, new Response(stream));
    const reader = await transport.requestWrapperStream(message());
    await reader.abort();
    assert.equal(calls[0].request.signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal((await reader.read()).done, true);
});

test('provider errors remain readable through the proxy', async () => {
    const error = '{"error":{"message":"Provider quota exceeded"}}';
    const {transport} = loadEngine({proxy}, new Response(error, {status: 429}));
    const reader = await transport.requestWrapperStream(message());
    assert.equal((await reader.read()).value, error);
});

for (const [name, settings, overrides] of [
    ['browser-configured provider', undefined, {}],
    ['request that opts out of proxying', {proxy}, {isUseProxy: false}],
    ['GET request', {proxy}, {method: 'GET'}]
]) {
    test(name + ' retains direct streaming without a session token', async () => {
        const {transport, calls} = loadEngine(settings === undefined ? null : settings);
        const input = message(overrides);
        await transport.requestWrapperStream(input);
        assert.equal(calls[0].url, target);
        assert.deepEqual(calls[0].request.headers, input.headers);
        assert.equal(calls[0].request.headers.Authorization, undefined);
        if (input.method === 'GET') assert.equal(calls[0].request.body, undefined);
        else assert.equal(calls[0].request.body, JSON.stringify(input.body));
    });
}
