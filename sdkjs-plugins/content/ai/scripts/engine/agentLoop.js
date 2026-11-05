/*
 * (c) Copyright Ascensio System SIA 2010-2025
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

// The chat agent loop: one call of runTurn() answers one chat message.
// It sends the history (with the system prompt, tool definitions and a
// snapshot of the document context) to the model, runs the tool calls the
// model asks for (each one approved by the user unless it is read-only,
// recorded as an AI edit and marked for provenance), sends the results
// back and repeats until the model answers in text, the user stops it or
// AgentState.MAX_LOOP_ITERATIONS is reached. Progress, tool cards and the
// final reply go to the chat window (chat.js); the tool exchange of the
// turn is sent back as a transcript for the next request.
(function(window, undefined)
{
	// Runs an agent tool; tools that are not readOnly are recorded as AI
	// edits (AIProvenance.runTool) and run as one undo step, optionally as
	// tracked changes (AIEdits.runTool, scripts/engine/aiEdits.js).
	function runAgentTool(func, funcName, args, requestEngine) {
		let isReadOnly = window.EditorHelper.isReadOnly(funcName);
		let run = function() {
			return func.call(args);
		};
		let marked = !window.AIProvenance ? run : function() {
			return window.AIProvenance.runTool(funcName, isReadOnly, requestEngine, run);
		};
		if (!window.AIEdits)
			return marked();
		return window.AIEdits.runTool(funcName, isReadOnly, marked, { engine: requestEngine });
	}

	// ── Tool approval ──────────────────────────────────────────────────
	// Every tool that is not marked readOnly needs the user's consent in
	// the chat window before it runs (scripts/engine/toolApproval.js, shared
	// with editor-initiated calls from "ai_onCallTool" in code.js).

	// Resolves true if the tool may run, false if the user declined, the
	// agent was stopped or the chat window went away.
	async function requestToolApproval(AgentState, toolCallId, funcName, argsObj) {
		if (window.ToolApproval.isPreapproved(funcName))
			return true;
		if (AgentState.isStopped)
			return false;
		return await window.ToolApproval.request({
			toolCallId: toolCallId,
			functionName: funcName,
			args: argsObj,
			source: "chat"
		});
	}

	// chatWindow: the Asc.PluginWindow of chat.html; AgentState: the state of
	// that window (chatWindow.js); messageHistory: what chat.js sends,
	// { messages, usedTools, turnId } or a plain message array.
	async function runTurn(chatWindow, AgentState, messageHistory) {
		AgentState.isStopped = false;

		let requestEngine = AI.Request.create(AI.ActionType.Chat);
		if (!requestEngine)
			return;

		if (!window.EditorHelper)
			window.EditorHelper = new EditorHelperImpl();

		let provider = AI.Storage.getProvider(requestEngine.modelUI.provider);
		let isSupportTools = provider && provider.isSupportTools(requestEngine.model, requestEngine.modelUI);

		// The chat sends { messages, usedTools, turnId } (chat.js sendMessage);
		// a plain array is the older format.
		let payload = Array.isArray(messageHistory) ? { messages: messageHistory } : (messageHistory || {});
		let history = Array.isArray(payload.messages) ? payload.messages : [];

		// History may hold tool exchanges from earlier turns (see
		// agentHistory.js). Keep them only if this model and provider can
		// take tool messages; otherwise rewrite them as plain text.
		let isSupportToolMessages = isSupportTools &&
			!(provider.isSupportToolMessages && !provider.isSupportToolMessages(requestEngine.model, requestEngine.modelUI));
		if (window.AgentHistory)
			history = isSupportToolMessages ? window.AgentHistory.sanitize(history) : window.AgentHistory.flatten(history);

		let lastUserText = "";
		for (let i = history.length - 1; i >= 0; i--) {
			if (history[i].role === "user" && typeof history[i].content === "string") {
				lastUserText = history[i].content;
				break;
			}
		}

		let requestData = {
			messages: history
		};

		// Live snapshot of the open file and the user's selection. Rebuilt on
		// every user turn and appended to the system prompt (not persisted).
		let docContext = window.DocumentContext ? await window.DocumentContext.get() : null;
		let ctxPrompt = window.DocumentContext ? window.DocumentContext.toPrompt(docContext) : "";

		// Only relevant tool categories are sent (toolCategories.js): inferred
		// from the message and selection, plus those used earlier in the chat.
		// loadTools adds categories during the turn; refreshToolSelection()
		// then updates the tools / prompt-based system prompt.
		let toolSession = window.EditorHelper.createToolSession({
			text: lastUserText,
			context: docContext,
			usedTools: Array.isArray(payload.usedTools) ? payload.usedTools : []
		});
		let ownsSystemPrompt = requestData.messages.length === 0 || requestData.messages[0].role !== "system";

		function getSystemContent() {
			let base = isSupportTools ? window.EditorHelper.getToolsSystemPrompt() : toolSession.getSystemPrompt();
			return [base, ctxPrompt].filter(function(s) { return !!s; }).join("\n\n");
		}

		if (isSupportTools) {
			let tools = toolSession.getTools();
			if (tools && tools.length > 0)
				requestData.tools = tools;
		}
		if (ownsSystemPrompt) {
			let systemContent = getSystemContent();
			if (systemContent)
				requestData.messages.unshift({ role: "system", content: systemContent });
		} else if (ctxPrompt) {
			requestData.messages[0] = {
				role: "system",
				content: requestData.messages[0].content + "\n\n" + ctxPrompt
			};
		}

		function refreshToolSelection() {
			if (!toolSession.consumeChanged())
				return;
			if (isSupportTools)
				requestData.tools = toolSession.getTools();
			else if (ownsSystemPrompt && requestData.messages.length > 0 && requestData.messages[0].role === "system")
				requestData.messages[0] = { role: "system", content: getSystemContent() };
		}

		// Messages added during this turn (tool calls, results, prompt-based
		// exchanges). Sent to the chat at the end of the turn so the next
		// request keeps the tool context (onAgentTranscript in chat.js).
		let turnMessages = [];
		let hasFinalReply = false;
		function pushTurnMessage(msg) {
			requestData.messages.push(msg);
			turnMessages.push(msg);
		}

		// LOOP
		let iteration = 0;
		let isAnswered = false;
		while (iteration < AgentState.MAX_LOOP_ITERATIONS && !AgentState.isStopped) {
			iteration++;

			await Asc.Editor.callMethod("StartAction", ["Block", "AI (" + requestEngine.modelUI.name + ")"]);

			let isSendedEndLongAction = false;
			async function checkEndAction() {
				if (!isSendedEndLongAction) {
					await Asc.Editor.callMethod("EndAction", ["Block", "AI (" + requestEngine.modelUI.name + ")"]);
					isSendedEndLongAction = true;
				}
			}

			let isStreamToChat = false;
			let fullResponse = await requestEngine.chatRequestAgent(requestData, false, async function(chunk) {
				if (!isStreamToChat) {
					isStreamToChat = true;
					chatWindow.command("onChatStreamStart");

					await checkEndAction();
				}

				chatWindow.command("onChatStreamChunk", chunk);
			});

			if (isStreamToChat) {
				chatWindow.command("onChatStreamEnd");
			}

			await checkEndAction();

			if (AgentState.isStopped)
				break;

			if (!fullResponse)
				fullResponse = { content : Asc.plugin.tr("Error:") + " [provider]" };

			let result = fullResponse.content || "";

			let toolCalls = fullResponse.tool_calls || null;

			// CHECK TOOLS
			if (toolCalls && toolCalls.length > 0) {
				// One assistant message carrying all tool calls, followed by one
				// tool message per call (required by OpenAI-compatible APIs).
				pushTurnMessage({
					role: 'assistant',
					content: result || null,
					tool_calls: toolCalls
				});

				let failed = false;
				for (let toolCall of toolCalls) {
					let funcName = toolCall.function ? toolCall.function.name : "";

					if (AgentState.isStopped || failed) {
						pushTurnMessage({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: AgentState.isStopped ? "Cancelled by the user." : "Skipped because a previous tool call failed."
						});
						continue;
					}

					let funcArgs = toolCall.function ? toolCall.function.arguments : null;
					let argsObj = {};
					let argsError = null;
					try {
						argsObj = parseToolArguments(funcArgs);
					} catch (e) {
						argsError = "Arguments are not valid JSON: " + e.message;
					}

					chatWindow.command("onToolCallStart", {
						type: 'native',
						id: toolCall.id,
						functionName: funcName,
						humanName: window.EditorHelper.getHumanName(funcName),
						arguments: JSON.stringify(argsObj, null, 2)
					});

					let toolResult = {};
					let declined = false;
					try {
						if (argsError)
							throw new AgentState.ToolError(argsError);
						let func = window.EditorHelper.names2funcs[funcName];
						if (!func)
							throw new AgentState.ToolError("Unknown tool \"" + funcName + "\". Available tools: " + Object.keys(window.EditorHelper.names2funcs).join(", "));

						if (!(await requestToolApproval(AgentState, toolCall.id, funcName, argsObj))) {
							declined = true;
							throw new AgentState.ToolError(TOOL_DECLINED_MESSAGE);
						}

						let toolResultMessage = await runAgentTool(func, funcName, argsObj, requestEngine);
						if (toolResultMessage)
							toolResultMessage = Asc.plugin.tr("Function executed successfully") + "\n" + JSON.stringify(toolResultMessage);
						else
							toolResultMessage = Asc.plugin.tr("Function executed successfully");
						toolResult.message = toolResultMessage;
					} catch (e) {
						if (declined) {
							// Not a failure: let the model see the refusal and continue.
							toolResult.error = TOOL_DECLINED_MESSAGE;
						} else {
							console.error("Tool execution error:", e);
							toolResult.error = Asc.plugin.tr("Error:") + "\n" + (e && e.message ? e.message : String(e));
							failed = true;
						}
					}

					chatWindow.command("onToolCallEnd", {
						type: 'native',
						id: toolCall.id,
						functionName: funcName,
						arguments: JSON.stringify(argsObj, null, 2),
						result: toolResult
					});

					pushTurnMessage({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: toolResult.message || toolResult.error || 'Success'
					});
				}
				refreshToolSelection(); // loadTools may have added categories
				continue;
			}

			// CHECK PROMT FUNCTION CALLING
			if (!toolCalls && result.startsWith("[functionCalling")) {
				if (AgentState.isStopped)
					break;

				try {
					let toolCallId = 'system_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

					let sysFuncName = window.EditorHelper.parseFuncCall(result).funcName || '';

					chatWindow.command("onToolCallStart", {
						type: 'system_prompt',
						id: toolCallId,
						call: result,
						humanName: sysFuncName ? window.EditorHelper.getHumanName(sysFuncName) : ''
					});

					let toolResult = await window.EditorHelper.callFunc(result, {
						beforeCall: function(name, args) {
							return requestToolApproval(AgentState, toolCallId, name, args);
						},
						call: function(func, name, args) {
							return runAgentTool(func, name, args, requestEngine);
						}
					});

					chatWindow.command("onToolCallEnd", {
						type: 'system_prompt',
						id: toolCallId,
						call: result,
						result: toolResult
					});

					pushTurnMessage({
						role: 'assistant',
						content: result
					});

					if (toolResult.declined) {
						pushTurnMessage({
							role: 'user',
							content: "SYSTEM: " + TOOL_DECLINED_MESSAGE + " Do not repeat this call; continue without it or ask the user how to proceed."
						});
					} else if (toolResult.error) {
						pushTurnMessage({
							role: 'user',
							content: "SYSTEM: Function execution failed with error: " + toolResult.error + "\nPlease try a different approach or inform the user about the issue."
						});							
					} else {
						let resultMessage = "SYSTEM: " + toolResult.message;
						if (toolResult.prompt) {
							resultMessage += "\n" + toolResult.prompt;
						}
						pushTurnMessage({
							role: 'user',
							content: resultMessage
						});							
					}
					refreshToolSelection(); // loadTools may have added categories
					continue;
				} catch (e) {
					console.error("Tool execution error:", e);
					break;
				}
			}

			if (!isStreamToChat && result) {
				chatWindow.command("onChatReply", result);
			}
			hasFinalReply = !!result;
			isAnswered = true;
			break;
		}

		if (!isAnswered && !AgentState.isStopped && iteration >= AgentState.MAX_LOOP_ITERATIONS) {
			chatWindow.command("onChatReply", "Maximum iterations reached. Please try again.");
		}

		window.EditorHelper.activeToolSession = null;
		if (turnMessages.length > 0) {
			chatWindow.command("onAgentTranscript", {
				turnId: payload.turnId || null,
				messages: turnMessages,
				hasFinalReply: hasFinalReply
			});
		}

		// always end (may be twice)
		chatWindow.command("onChatStreamEnd");
	}

	window.AIAgentLoop = {
		runTurn : runTurn,
		runTool : runAgentTool
	};

})(window);
