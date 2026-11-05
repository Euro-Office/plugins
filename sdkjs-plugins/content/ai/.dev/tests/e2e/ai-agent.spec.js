// SPDX-License-Identifier: AGPL-3.0-only
//
// End to end: a real Document Server editor with this plugin, the chat
// agent talking to a scripted OpenAI-compatible stub. The stub asks for
// editParagraph (needs approval) and then readDocument, so the last request
// carries the document content as read back through the real Document API.

import { test, expect } from "@playwright/test";
import { startStubLLM } from "./stub-llm.js";

const GREETING = "Hello from the AI agent";

test("the agent edits a document through tool calls after approval", async ({ page, context, baseURL }) => {
	const stub = await startStubLLM({
		port: Number(process.env.E2E_STUB_PORT || 18080),
		script: [
			{ tool_calls: [{ id: "call_1", name: "editParagraph", arguments: { index: 1, action: "replace", text: GREETING } }] },
			{ tool_calls: [{ id: "call_2", name: "readDocument", arguments: {} }] },
			{ content: "Done." }
		]
	});
	try {
		// Plugin settings: one OpenAI-compatible provider pointing at the stub,
		// with chat + tools capabilities (257), used for the chat action.
		const storage = {
			version: 4,
			providers: { Stub: { name: "Stub", url: "http://localhost:" + stub.port + "/v1", key: "test", models: [{ id: "stub-model", name: "stub-model", endpoints: [1], options: { max_input_tokens: 128000 } }] } },
			models: [{ id: "stub-model", name: "stub-model", provider: "Stub", capabilities: 257 }],
			customProviders: {}
		};
		const origin = new URL(baseURL).origin;
		await context.addInitScript(([s, o]) => {
			if (location.origin === o && !localStorage.getItem("onlyoffice_ai_plugin_storage_key")) {
				localStorage.setItem("onlyoffice_ai_plugin_storage_key", JSON.stringify(s));
				localStorage.setItem("onlyoffice_ai_actions_key", JSON.stringify({ Chat: { model: "stub-model" } }));
			}
		}, [storage, origin]);

		// Plugin pages load the plugin SDK from onlyoffice.github.io; serve the
		// copy bundled with the Document Server instead (hermetic, no internet).
		await context.route(/^https:\/\/onlyoffice\.github\.io\/sdkjs-plugins\/v1\/(.*)$/, async (route) => {
			const file = route.request().url().replace(/^https:\/\/onlyoffice\.github\.io\/sdkjs-plugins\/v1\//, "");
			const res = await fetch(origin + "/sdkjs-plugins/v1/" + file);
			await route.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || undefined });
		});

		await page.goto("/example/editor?fileExt=docx");
		const editor = page.frameLocator('iframe[name="frameEditor"]');
		await editor.locator("li.ribtab", { hasText: /^\s*AI\s*$/ }).first().click({ timeout: 90000 });
		await editor.locator(".btn-slot, button", { hasText: "Chatbot" }).first().click();

		let chat;
		await expect.poll(() => (chat = page.frames().find((f) => f.url().includes("chat.html"))) ? 1 : 0, { timeout: 30000 }).toBe(1);
		await chat.locator("#input_message").fill("Replace the first paragraph with a greeting");
		await chat.locator("#input_message_submit").click();

		// editParagraph is not read-only: the chat asks first.
		const approval = chat.locator(".tool_call_approval");
		await expect(approval).toBeVisible({ timeout: 30000 });
		await expect(approval.locator(".tool_call_approval_question")).toContainText("Edit Paragraph");
		await approval.getByRole("button", { name: "Allow", exact: true }).click();

		await expect.poll(() => stub.requests.length, { timeout: 60000 }).toBe(3);
		await expect(chat.locator("#chat")).toContainText("Done.", { timeout: 30000 });

		const [first, second, third] = stub.requests;
		expect(first.tools.map((t) => t.function.name)).toContain("editParagraph");
		expect(first.messages[0].role).toBe("system");
		const editResult = second.messages.find((m) => m.tool_call_id === "call_1");
		expect(editResult.content).toMatch(/^Function executed successfully/);
		const readResult = third.messages.find((m) => m.tool_call_id === "call_2");
		const doc = JSON.parse(readResult.content.split("\n").slice(1).join("\n"));
		expect(doc.elements[0].text.trim()).toBe(GREETING);
	} finally {
		await stub.close();
	}
});
