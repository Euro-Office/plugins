// SPDX-License-Identifier: AGPL-3.0-only
//
// Minimal OpenAI-compatible chat completions server for the e2e test. It
// replies with a scripted list of responses (one per request, streamed as
// SSE like the real API) and records every request body.

import http from "node:http";

export function startStubLLM({ port = 0, script = [] } = {}) {
	const requests = [];
	const queue = script.slice();

	function sse(res, chunks) {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
		for (const c of chunks)
			res.write("data: " + JSON.stringify(c) + "\n\n");
		res.write("data: [DONE]\n\n");
		res.end();
	}

	function chunksFor(step) {
		const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", model: "stub-model" };
		const out = [];
		if (step.content)
			out.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.content } }] });
		(step.tool_calls || []).forEach((tc, i) => {
			out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }] } }] });
			out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.arguments || {}) } }] } }] });
		});
		out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step.tool_calls ? "tool_calls" : "stop" }] });
		return out;
	}

	const server = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS"
			});
			return res.end();
		}
		if (req.method === "GET" && req.url.endsWith("/models")) {
			res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
			return res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
		}
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			let json = null;
			try { json = JSON.parse(body); } catch (e) {}
			requests.push(json);
			const step = queue.length ? queue.shift() : { content: "Done." };
			const resolved = typeof step === "function" ? step(json, requests) : step;
			if (json && json.stream)
				return sse(res, chunksFor(resolved));
			res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
			res.end(JSON.stringify({
				id: "chatcmpl-stub", object: "chat.completion", model: "stub-model",
				choices: [{ index: 0, finish_reason: "stop", message: {
					role: "assistant", content: resolved.content || null,
					tool_calls: resolved.tool_calls ? resolved.tool_calls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) } })) : undefined
				} }]
			}));
		});
	});

	return new Promise((resolve) => {
		server.listen(port, "0.0.0.0", () => resolve({
			port: server.address().port,
			requests,
			queue,
			close: () => new Promise((r) => server.close(r))
		}));
	});
}
