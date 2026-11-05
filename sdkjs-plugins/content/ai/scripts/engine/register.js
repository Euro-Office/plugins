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

async function registerButtons(window, undefined)
{
	window.AI = window.AI || {};
	var AI = window.AI;
	
	// Provenance metadata for an AI action (see scripts/helpers/aiProvenance.js).
	// Passed to the Asc.Library insert methods, which mark the inserted
	// content and record the action in the document properties.
	function provMeta(action, requestEngine) {
		return window.AIProvenance ? window.AIProvenance.meta(action, requestEngine) : null;
	}

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

	function getToolBarButtonIcons(icon) {
		return "resources/icons/%theme-type%(light|dark)/big/" + icon + "%scale%(default).png";
	}

	function getContextMenuButtonIcons(icon) {
		return "resources/icons/%theme-type%(light|dark)/" + icon + "%scale%(default).png";
	}

	// register contextmenu buttons
	let buttonMain = new Asc.ButtonContextMenu();
	buttonMain.text = "AI";
	buttonMain.icons = getContextMenuButtonIcons("general-ai");
	buttonMain.addCheckers("All");

	function chatWindowShow(attachedText, isForceSend)
	{
		if (window.chatWindow) {
			window.chatWindow.activate();
			if (attachedText && attachedText.trim()) {
				window.chatWindow.command("onAttachedText", { text: attachedText, forceSend: !!isForceSend });
			}
			return;
		}

		let requestEngine = AI.Request.create(AI.ActionType.Chat);
		if (!requestEngine)
			return;

		let panelPlace = window.localStorage.getItem("onlyoffice_ai_chat_placement") || "window";
		if (panelPlace === "panel")
			panelPlace = "panelRight";

		if (attachedText && attachedText.trim())
			panelPlace = "panelRight";

		let variation = {
			url : "chat.html",
			description : window.Asc.plugin.tr("Chatbot"),
			isVisual : true,
			buttons : [],
			icons: "resources/icons/%theme-name%(theme-default|theme-classic-light)/%theme-type%(light|dark)/ask-ai%state%(normal|active)%scale%(default).png",
			isModal : false,
			isCanDocked: true,
			dockedPlace: "panelRight",
			type: panelPlace,
			EditorsSupport : ["word", "slide", "cell", "pdf"],
			size : [ 400, 400 ]
		};

		let hasOpenedOnce = false;

		var chatWindow = new window.Asc.PluginWindow();
		window.ToolApproval.bindWindow(chatWindow);
		chatWindow.attachEvent("onWindowReady", function() {
			window.ToolApproval.setWindowReady(chatWindow);
			Asc.Editor.callMethod("ResizeWindow", [chatWindow.id, [400, 400], [400, 400], [0, 0]]);
			if(!hasOpenedOnce && attachedText && attachedText.trim()) {
				chatWindow.command("onAttachedText", isForceSend
					? { text: attachedText, forceSend: true }
					: attachedText
				);
			}

			function isSupportVoiceInput() {
				if (window.AscDesktopEditor)
					return false;
				if (window.location.protocol.startsWith("https"))
					return true;

				return true;
			}

			chatWindow.command("onVoiceInputSupport", isSupportVoiceInput());

			hasOpenedOnce = true;

			// Selection suggestion chips (scripts/engine/selectionSuggestions.js).
			if (window.SelectionSuggestions)
				window.SelectionSuggestions.attach(chatWindow, chatWindowShow);
		});
		
		// Tool schemas and system prompts are no longer cached here: they
		// depend on the tool categories selected per request and are cached
		// per category set in EditorHelper (helperFuncs.js).
		var AgentState = {
			MAX_LOOP_ITERATIONS : 20,
			isStopped : false
		};
		window.AgentState = AgentState;

		class ToolError extends Error {
			constructor(message) {
				super(message);
				this.name = "ToolError";
			}
		}
		window.AgentState.ToolError = ToolError;

		// ── Tool approval ──────────────────────────────────────────────────
		// Every tool that is not marked readOnly needs the user's consent in
		// the chat window before it runs (scripts/engine/toolApproval.js, shared
		// with editor-initiated calls from "ai_onCallTool" in code.js).

		// Resolves true if the tool may run, false if the user declined, the
		// agent was stopped or the chat window went away.
		async function requestToolApproval(toolCallId, funcName, argsObj) {
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

		AgentState.denyPendingApprovals = window.ToolApproval.denyAll;

		chatWindow.attachEvent("onToolApprovalResponse", function(data) {
			window.ToolApproval.respond(data, AgentState.isStopped);
		});

		chatWindow.attachEvent("onStopAgent", function() {
			AgentState.isStopped = true;
			window.ToolApproval.denyAll();
		});

		// ── Citations ──────────────────────────────────────────────────────
		// The chat sends the href of a clicked eo:// location link. It is
		// validated again here (citations.js) and only ever selects / scrolls
		// to a place in the open file: read-only, so no approval is needed.
		// Invalid links and links for another editor type are ignored.
		chatWindow.attachEvent("onNavigate", async function(data) {
			let href = (data && typeof data === "object") ? data.href : data;
			let loc = window.EOLinks ? window.EOLinks.parse(href) : null;
			if (!loc || loc.editor !== Asc.Editor.getType())
				return;
			if (!window.EditorHelper)
				window.EditorHelper = new EditorHelperImpl();
			try {
				await navigateToLocation(loc);
			} catch (e) {
				console.warn("[AI] could not navigate to " + href + ":", e && e.message ? e.message : e);
			}
		});

		async function navigateToLocation(loc) {
			let funcs = window.EditorHelper.names2funcs;
			switch (loc.type) {
				case "paragraph": {
					Asc.scope.eoNavIndex = loc.index;
					await Asc.Editor.callCommand(function() {
						let doc = Api.GetDocument();
						let el = doc.GetElement(Asc.scope.eoNavIndex - 1);
						if (!el)
							return false;
						if (typeof el.Select === "function")
							el.Select();
						else if (typeof el.GetRange === "function")
							el.GetRange().Select();
						return true;
					});
					break;
				}
				case "find": {
					// Same search + select as the selectText tool.
					if (funcs.selectText)
						await funcs.selectText.call({ query: loc.text });
					break;
				}
				case "range": {
					// Activates the sheet and selects the range (selectRange tool).
					if (funcs.selectRange)
						await funcs.selectRange.call({ range: loc.range, sheet: loc.sheet });
					break;
				}
				case "slide": {
					if (funcs.goToSlide)
						await funcs.goToSlide.call({ slideNumber: loc.slide });
					if (loc.shape) {
						Asc.scope.eoNavShape = { slide: loc.slide, shape: loc.shape };
						await Asc.Editor.callCommand(function() {
							let p = Asc.scope.eoNavShape;
							let slide = Api.GetPresentation().GetSlideByIndex(p.slide - 1);
							if (!slide)
								return false;
							let drawings = slide.GetAllDrawings ? slide.GetAllDrawings() : slide.GetAllShapes();
							let d = drawings[p.shape - 1];
							if (d && typeof d.Select === "function")
								d.Select();
							return true;
						});
					}
					break;
				}
			}
		}

		// "Undo AI changes" / "Accept all" / "Reject all" on a chat message
		// (scripts/engine/aiEdits.js).
		chatWindow.attachEvent("onAIEditsAction", async function(data) {
			if (!data || !data.turnId)
				return;
			let res = await window.AIEdits.performAction(data.turnId, data.action);
			chatWindow.command("onAIEditsActionResult", res);
		});

		// One AI turn per message: its document changes are summarized for the
		// "Undo AI changes" bar (AIEdits.wrapChatHandler).
		chatWindow.attachEvent("onChatMessage", window.AIEdits.wrapChatHandler(function() { return window.chatWindow === chatWindow ? chatWindow : null; }, async function(messageHistory) {
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

							if (!(await requestToolApproval(toolCall.id, funcName, argsObj))) {
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
								return requestToolApproval(toolCallId, name, args);
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
				break;
			}

			if (iteration >= AgentState.MAX_LOOP_ITERATIONS) {
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
		}));
		chatWindow.attachEvent("onChatReplace", async function(data) {
			// Chat answers applied to the document with the message buttons.
			let meta = provMeta("chat:" + data.type, AI.Request.create(AI.ActionType.Chat, true));
			switch (data.type) {
				case "review": {
					if (Asc.plugin.info.editorType === "word")
						await Asc.Library.InsertAsReview(data.data, true, meta);
					else
						await Asc.Library.InsertAsComment(data.data, meta);
					break;
				}
				case "comment": {
					await Asc.Library.InsertAsComment(data.data, meta);
					break;
				}
				case "insert": {
					await Asc.Library.InsertAsHTML(data.data, meta);
					break;
				}
				case "replace": {
					await Asc.Library.ReplaceTextSmart([data.data], meta);
					break;
				}
			}
		});	
		chatWindow.attachEvent("onDockedChanged", async function(type) {
			window.localStorage.setItem("onlyoffice_ai_chat_placement", type);

			async function waitSaveSettings()
			{
				return new Promise(resolve => (function(){
					chatWindow.attachEvent("onUpdateState", function(type) {
						resolve();
					});
					chatWindow.command("onUpdateState");
				})());
			};
			
			await waitSaveSettings();
			Asc.Editor.callMethod("OnWindowDockChangedCallback", [chatWindow.id]);
		});
		chatWindow.show(variation);

		window.chatWindow = chatWindow;
	}
	window.chatWindowShow = chatWindowShow;

	let editorVersion = await Asc.Library.GetEditorVersion();
	if (editorVersion >= 9002000 && Asc.Editor.getType() !== "pdf")
	{
		let buttonSub = new Asc.ButtonContextMenu(buttonMain);
		buttonSub.text = "Grammar & Spelling";
		buttonSub.icons = getContextMenuButtonIcons("grammar");
		buttonSub.editors = ["word"];
		buttonSub.addCheckers("Target", "Selection");
		
		let buttonAll = new Asc.ButtonContextMenu(buttonSub);
		buttonAll.text = "Check all";
		buttonAll.editors = ["word"];
		buttonAll.addCheckers("Target", "Selection");

		buttonAll.attachOnClick(async function(data){
			onCheckGrammarSpelling(false);
		});

		let buttonCurrent = new Asc.ButtonContextMenu(buttonSub);
		buttonCurrent.text = "Check current text";
		buttonCurrent.editors = ["word"];
		buttonCurrent.addCheckers("Target", "Selection");

		buttonCurrent.attachOnClick(async function(data){
			onCheckGrammarSpelling(true);
		});
	
	}

	// Submenu summarize:
	if (Asc.Editor.getType() !== "pdf")
	{
		let button = new Asc.ButtonContextMenu(buttonMain);
		button.text = "Summarization";
		button.icons = getContextMenuButtonIcons("summarization");
		button.editors = ["word"];
		button.addCheckers("Selection");
		button.attachOnClick(async function(data){
			let requestEngine = AI.Request.create(AI.ActionType.Summarization);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getSummarizationPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = "Summary:\n\n" + result;
			await Asc.Library.InsertAsText(result, provMeta("summarization", requestEngine));
		});
	}

	// Submenu Text Analysis
	if (true)
	{
		let button1 = new Asc.ButtonContextMenu(buttonMain);
		button1.text = "Text analysis";
		button1.icons = getContextMenuButtonIcons("text-analysis-ai");
		button1.editors = ["word"];
		button1.addCheckers("Target", "Selection");

		let button2 = new Asc.ButtonContextMenu(button1);
		button2.text = "Rewrite differently";
		button2.editors = ["word"];
		button2.addCheckers("Selection");
		button2.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getTextRewritePrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = result.replace(/\n\n/g, '\n');
			await Asc.Library.PasteText(result, provMeta("rewrite", requestEngine));
		});

		let button3 = new Asc.ButtonContextMenu(button1);
		button3.text = "Make longer";
		button3.editors = ["word"];
		button3.addCheckers("Selection");
		button3.attachOnClick(async function(data){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getTextLongerPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = result.replace(/\n\n/g, '\n');
			await Asc.Library.PasteText(result, provMeta("makeLonger", requestEngine));
		});

		let button4 = new Asc.ButtonContextMenu(button1);
		button4.text = "Make shorter";
		button4.editors = ["word"];
		button4.addCheckers("Selection");
		button4.attachOnClick(async function(data){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getTextShorterPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = result.replace(/\n\n/g, '\n');
			await Asc.Library.PasteText(result, provMeta("makeShorter", requestEngine));
		});

		let button5 = new Asc.ButtonContextMenu(button1);
		button5.text = "Explain text in comment";
		button5.separator = true;
		button5.editors = ["word"];
		button5.addCheckers("Target", "Selection");
		button5.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			if (!content)
				content = await Asc.Library.GetCurrentWord();

			if (!content)
				return;

			let prompt = Asc.Prompts.getExplainPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = result.replace(/\n\n/g, '\n');
			await Asc.Library.InsertAsComment(result, provMeta("explainComment", requestEngine));
		});

		let button6 = new Asc.ButtonContextMenu(button1);
		button6.text = "Explain text in hyperlink";
		button6.separator = true;
		button6.editors = ["word"];
		button6.addCheckers("Selection");
		button6.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getExplainAsLinkPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = result.replace(/\n\n/g, '\n');
			await Asc.Library.InsertAsHyperlink(result, undefined, provMeta("explainHyperlink", requestEngine));
		});

		let button7 = new Asc.ButtonContextMenu(button1);
		button7.text = "Fix spelling & grammar";
		button7.separator = true;
		button7.editors = ["word"];
		button7.addCheckers("Selection");
		button7.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getFixAndSpellPrompt(content);

			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			// "fixSpellingGrammar" is an assistive edit: AIProvenance.EXEMPT_ACTIONS
			// keeps it unmarked (Art. 50(2) standard-editing exception).
			if (result !== 'The text is correct, there are no errors in it.')
			   await Asc.Library.ReplaceTextSmart([result], provMeta("fixSpellingGrammar", requestEngine));
			else
				console.log('The text is correct, there are no errors in it.');
		});

		let button8 = new Asc.ButtonContextMenu(button1);
		button8.text = "Keywords";
		button8.editors = ["word"];
		button8.addCheckers("Selection");
		button8.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.TextAnalyze);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			let prompt = Asc.Prompts.getTextKeywordsPrompt(content);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			await Asc.Library.InsertAsText(result, provMeta("keywords", requestEngine));
		});
	}

	// Submenu Translate
	if (true)
	{
		let button1 = new Asc.ButtonContextMenu(buttonMain);
		button1.text = "Translate";
		button1.icons = getContextMenuButtonIcons("translation");
		button1.editors = ["word", "slide", "cell"];
		button1.addCheckers("Selection");

		let button2 = new Asc.ButtonContextMenu(button1);
		button2.text = "English";
		button2.editors = ["word", "slide", "cell"];
		button2.addCheckers("Selection");
		button2.data = "English";
		button2.attachOnClick(async function(data){
			let requestEngine = AI.Request.create(AI.ActionType.Translation);
			if (!requestEngine)
				return;

			let lang = data;
			let content = await Asc.Library.GetSelectedText();
			if (!content)
				return;

			let prompt = Asc.Prompts.getTranslatePrompt(content, lang);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = Asc.Library.getTranslateResult(result, content);

			await Asc.Library.PasteText(result, provMeta("translate", requestEngine));
		});

		let button3 = button2.copy();
		button3.text = "French";
		button3.data = "French";

		let button4 = button2.copy();
		button4.text = "German";
		button4.data = "German";

		let button5 = button2.copy();
		button5.text = "Chinese";
		button5.data = "Chinese";

		let button6 = button2.copy();
		button6.text = "Japanese";
		button6.data = "Japanese";

		let button7 = button2.copy();
		button7.text = "Russian";
		button7.data = "Russian";

		let button8 = button2.copy();
		button8.text = "Korean";
		button8.data = "Korean";

		let button9 = button2.copy();
		button9.text = "Spanish";
		button9.data = "Spanish";

		let button10 = button2.copy();
		button10.text = "Italian";
		button10.data = "Italian";
	}

	if (true)
	{
		let button1 = new Asc.ButtonContextMenu(buttonMain);
		button1.text = "Show hyperlink content";
		button1.addCheckers("Hyperlink");

		button1.onContextMenuShowExtendItem = function(options, item)
		{
			item.data = options.value;
		};

		button1.attachOnClick(function(data){
			let variation = {
				url : "hyperlink.html",
				description : window.Asc.plugin.tr("Hyperlink"),
				isVisual : true,
				buttons : [],
				isModal : false,
				EditorsSupport : ["word", "slide", "cell", "pdf"],
				size : [ 1000, 1000 ]
			};

			var linkWindow = new window.Asc.PluginWindow();
			linkWindow.attachEvent("onGetLink", async function(){
				let link = data;
				if (!link)
					link = await Asc.Library.GetSelectedText();
				link = link.replace(/\n/g, '');
				link = link.replace(/\r/g, '');
				linkWindow.command("onSetLink", link);
			});
			linkWindow.show(variation);
		});
	}

	const on_click_ocr = async function () {
		let requestEngine = AI.Request.create(AI.ActionType.OCR);
		if (!requestEngine)
			return;

		let content = await Asc.Library.GetSelectedImage();
		if (!content) {
			console.log("you need to select an image to use ocr")
			return;
		}

		let result = await requestEngine.imageOCRRequest(content);
		if (!result) return;

		await Asc.Library.InsertAsMD(result, [Asc.PluginsMD.latex, Asc.PluginsMD.hr], provMeta("ocr", requestEngine));
	}

	const on_click_text_to_image = async function (params) {
		let requestEngine = AI.Request.create(AI.ActionType.ImageGeneration);
		if (!requestEngine)
			return;

		let content = await Asc.Library.GetSelectedText();
		if (!content) {
			console.log("you need to select text to generate image")
			return;
		}

		let result = await requestEngine.imageGenerationRequest(content);
		if (!result) return;

		let meta = provMeta("textToImage", requestEngine);
		if (Asc.plugin.info.editorSubType === "pdf")
			return await Asc.Library.AddGeneratedImage(result, meta);
		await Asc.Library.AddOleObject(result, content, meta);
	}

	if (true)
	{
		let buttonImages = new Asc.ButtonContextMenu(buttonMain);
		buttonImages.text = "Image";
		buttonImages.icons = getContextMenuButtonIcons("image-ai");
		buttonImages.addCheckers("Selection", "Image", "OleObject");

		let buttonGen = new Asc.ButtonContextMenu(buttonImages);
		buttonGen.text = "Text to Image";
		buttonGen.addCheckers("Selection");
		buttonGen.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.ImageGeneration);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedText();
			if (!content)
				return;

			let result = await requestEngine.imageGenerationRequest(content);
			if (!result) return;

			let meta = provMeta("textToImage", requestEngine);
			if (Asc.plugin.info.editorSubType === "pdf")
				return await Asc.Library.AddGeneratedImage(result, meta);
			await Asc.Library.AddOleObject(result, content, meta);
		});

		let buttonOCR = new Asc.ButtonContextMenu(buttonImages);
		buttonOCR.text = "OCR";
		buttonOCR.addCheckers("Image", "OleObject");
		buttonOCR.attachOnClick(on_click_ocr);

		let buttonExplainImage = new Asc.ButtonContextMenu(buttonImages);
		buttonExplainImage.text = "Image to Text";
		buttonExplainImage.addCheckers("Image", "OleObject");
		buttonExplainImage.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.Vision);
			if (!requestEngine)
				return;

			let content = await Asc.Library.GetSelectedImage();
			if (!content)
				return;

			let result = await requestEngine.imageVisionRequest({
				prompt : Asc.Prompts.getImageDescription(),
				image : content
			});
			if (!result) return;

			await Asc.Library.InsertAsMD(result, undefined, provMeta("imageToText", requestEngine));
		});
	}

	// Smart actions: context-aware agent tasks for the current selection.
	// Each action hands a prompt to the chat agent, which sees the selection
	// (see DocumentContext) and can read/modify the document through tools.
	if (Asc.Editor.getType() !== "pdf")
	{
		let editorType = Asc.Editor.getType();
		// Action table: scripts/helpers/smartActions.js (shared with the chat chips).
		let actions = window.SmartActions ? window.SmartActions.all(editorType) : [];
		if (actions.length) {
			let buttonSmart = new Asc.ButtonContextMenu(buttonMain);
			buttonSmart.text = "Smart actions";
			buttonSmart.icons = getContextMenuButtonIcons("ask-ai");
			buttonSmart.editors = [editorType];
			buttonSmart.addCheckers("Selection");

			for (let i = 0; i < actions.length; i++) {
				let action = actions[i];
				let button = new Asc.ButtonContextMenu(buttonSmart);
				button.text = action.text;
				button.editors = [editorType];
				button.addCheckers("Selection");
				button.attachOnClick(function() {
					chatWindowShow(action.prompt + window.SmartActions.LANG_HINT, true);
				});
			}

			let buttonAsk = new Asc.ButtonContextMenu(buttonSmart);
			buttonAsk.text = "Ask about selection...";
			buttonAsk.separator = true;
			buttonAsk.editors = [editorType];
			buttonAsk.addCheckers("Selection");
			buttonAsk.attachOnClick(function() {
				chatWindowShow(Asc.plugin.tr("About the selection:") + " ", false);
			});
		}
	}

	if (true)
	{
		let button1 = new Asc.ButtonContextMenu(buttonMain);
		button1.text = "Chatbot";
		button1.separator = true;
		button1.icons = getContextMenuButtonIcons("ask-ai");
		button1.addCheckers("All");
		button1.attachOnClick(async function(){
			let selectedText = await Asc.Library.GetSelectedText();
			chatWindowShow(selectedText);
		});
	}

	if (false)
	{
		let button1 = new Asc.ButtonContextMenu(buttonMain);
		button1.text = "Settings";
		button1.separator = true;
		button1.addCheckers("All");
		button1.attachOnClick(function(){
			onOpenSettingsModal();
		});
	}

	// register toolbar buttons
	let buttonMainToolbar = new Asc.ButtonToolbar();
	buttonMainToolbar.text = "AI";

	window.buttonMainToolbar = buttonMainToolbar;
	window.getToolBarButtonIcons = getToolBarButtonIcons;

	window.buttonSettings = null;

	if (!AI.serverSettings)
	{
		window.buttonSettings = new Asc.ButtonToolbar(buttonMainToolbar);
		window.buttonSettings.text = "Settings";
		window.buttonSettings.icons = getToolBarButtonIcons("settings");
		window.buttonSettings.attachOnClick(function(data){
			onOpenSettingsModal();
		});
	}

	if (true)
	{
		let button1 = new Asc.ButtonToolbar(buttonMainToolbar);

		if (!AI.serverSettings)
			button1.separator = true;
		
		button1.text = "Chatbot";
		button1.icons = getToolBarButtonIcons("ask-ai");
		button1.attachOnClick(function(data){
			chatWindowShow();
		});

		if (Asc.Editor.getType() !== "pdf") {
			let button2 = new Asc.ButtonToolbar(buttonMainToolbar);
			button2.text = "Summarization";
			button2.icons = getToolBarButtonIcons("summarization");
			button2.attachOnClick(async function(data){
				let requestEngine = AI.Request.create(AI.ActionType.Summarization);
				if (!requestEngine)
					return;

				onOpenSummarizationModal();
			});
		}

		if (false) {
			let button3 = new Asc.ButtonToolbar(buttonMainToolbar);
			button3.text = "Text to Image";
			button3.icons = getToolBarButtonIcons("text-to-image");
			button3.attachOnClick(on_click_text_to_image);
		}

		let button4 = new Asc.ButtonToolbar(buttonMainToolbar);
		button4.text = "Translation";
		button4.icons = getToolBarButtonIcons("translation");
		button4.menu = [{
				text:'Settings',
				id:'t10n-settings',
				onclick: () => {
					onTranslateSettingsModal();
				}}];
		button4.split = true;
		button4.attachOnClick(async function(){
			let requestEngine = AI.Request.create(AI.ActionType.Translation);
			if (!requestEngine)
				return;

			const ls_lang_key = "onlyoffice_ai_plugin_translate_lang";
			const currLang = window.localStorage.getItem(ls_lang_key);

			let lang = !!currLang ? currLang : "english";
			let content = await Asc.Library.GetSelectedText();
			if (!content)
				return;

			let prompt = Asc.Prompts.getTranslatePrompt(content, lang);
			let result = await requestEngine.chatRequest(prompt);
			if (!result) return;

			result = Asc.Library.getTranslateResult(result, content);
			await Asc.Library.PasteText(result, provMeta("translate", requestEngine));
		});

		if (false && Asc.Editor.getType() !== "pdf")
		{
			let button2 = new Asc.ButtonToolbar(buttonMainToolbar);
			button2.text = "OCR";
			button2.icons = getToolBarButtonIcons("ocr");
			button2.attachOnClick(on_click_ocr);
		}

		let lastButton = null;
		if (editorVersion >= 9002000 && Asc.Editor.getType() === "word")
		{
			let buttonGS = new Asc.ButtonToolbar(buttonMainToolbar);
			buttonGS.text = "Grammar & Spelling";
			buttonGS.icons = getToolBarButtonIcons("grammar");
			buttonGS.menu = [{
				text: 'Check all',
				id: 'sg10n-check-all',
				onclick: () => onCheckGrammarSpelling(false)
			}, 
			{
				text: 'Check current text',
				id: 'sg10n-check-text',
				onclick: () => onCheckGrammarSpelling(true)
			}];
			buttonGS.attachOnClick(async function(){
				onCheckGrammarSpelling(true);
			});
			lastButton = buttonGS;			
		}

		if (editorVersion >= 9003000) {

			if (window.AscDesktopEditor && Asc.Editor.getType() === "word") 
			{
				let isFillForm = await Asc.Editor.callMethod("IsFillingOFormMode");
				if (true === isFillForm)
				{
					let buttonGenerate = new Asc.ButtonToolbar(buttonMainToolbar);
					buttonGenerate.text = "Generate Document";
					buttonGenerate.icons = window.getToolBarButtonIcons("form-to-doc");
					
					buttonGenerate.attachOnClick(async function(){
						let content = await getFormGenerationPrompt();
						window.AscDesktopEditor.generateNew("docx", "ai", content);
					});

					lastButton = buttonGenerate;
				}
			}
		}

		if (lastButton)
			lastButton.split = true;

		let neededVersionForAiAssistant = 9002000;
		/*if (window.AscDesktopEditor) {
			neededVersionForAiAssistant = 9003000;
		}*/
		if (editorVersion >= neededVersionForAiAssistant && Asc.Editor.getType() === "word")
		{	
			const buttonCustomAssistant = new Asc.ButtonToolbar(buttonMainToolbar);
			buttonCustomAssistant.text = "Create AI assistant";
			buttonCustomAssistant.icons = getToolBarButtonIcons("plugin-writer");
			buttonCustomAssistant.separator = true;
			buttonCustomAssistant.attachOnClick(function(){
				customAssistantWindowShow();
			});
			const savedAssistants = JSON.parse(
				localStorage.getItem("onlyoffice_ai_saved_assistants") || "[]"
			);

			savedAssistants.forEach(element => {
				const buttonAssistant = new Asc.ButtonToolbar(buttonMainToolbar);
				buttonAssistant.text = element.name;
				buttonAssistant.icons = getToolBarButtonIcons("written-plugin");
				buttonAssistant.split = true;
				buttonAssistant.enableToggle = true;
				buttonAssistant.menu = [{
					text: 'Edit',
					id: element.id + '-edit',
					onclick: () => customAssistantWindowShow(element.id, buttonAssistant)
				}, 
				{
					text: 'Delete',
					id: element.id + '-delete',
					onclick: () => customAssistantWindowDeleteConfirm(element.id, buttonAssistant)
				}];
				buttonAssistant.attachOnClick(async function(){
					customAssistantOnClickToolbarIcon(element.id, buttonAssistant);
				});
			});
		}
	}

	// register actions

	AI.ActionType = {
		Chat             : "Chat",
		Summarization    : "Summarization",
		Translation      : "Translation",
		TextAnalyze      : "TextAnalyze",
		ImageGeneration  : "ImageGeneration",
		OCR              : "OCR",
		Vision           : "Vision"
	};

	AI.Actions = Object.create(null);

	function ActionUI(name, icon, modelId, capabilities) {
		this.name = name || "";
		this.icon = icon || "";
		this.model = modelId || "";
		this.capabilities = (capabilities === undefined) ? AI.CapabilitiesUI.Chat : capabilities;
	}

	AI.Actions[AI.ActionType.Chat]            = new ActionUI("Chatbot", "ask-ai");
	AI.Actions[AI.ActionType.Summarization]   = new ActionUI("Summarization", "summarization");
	AI.Actions[AI.ActionType.Translation]     = new ActionUI("Translation", "translation");
	AI.Actions[AI.ActionType.TextAnalyze]     = new ActionUI("Text analysis", "text-analysis-ai");
	AI.Actions[AI.ActionType.ImageGeneration] = new ActionUI("Image generation", "image-ai", "", AI.CapabilitiesUI.Image);
	AI.Actions[AI.ActionType.OCR]             = new ActionUI("OCR", "ocr", "", AI.CapabilitiesUI.Vision);
	AI.Actions[AI.ActionType.Vision]          = new ActionUI("Vision", "vision-ai", "", AI.CapabilitiesUI.Vision);

	AI.ActionsGetKeys = function()
	{
		return [
			AI.ActionType.Chat,
			AI.ActionType.Summarization,
			AI.ActionType.Translation,
			AI.ActionType.TextAnalyze,
			AI.ActionType.ImageGeneration,
			AI.ActionType.OCR,
			AI.ActionType.Vision
		];
	};

	AI.ActionsGetSorted = function()
	{
		let keys = AI.ActionsGetKeys();
		let count = keys.length;
		let actions = new Array(count);
		for (let i = 0; i < count; i++)
		{
			let src = AI.Actions[keys[i]];
			actions[i] = {
				id : keys[i],
				name : Asc.plugin.tr(src.name),
				icon : src.icon,
				model : src.model,
				capabilities : src.capabilities
			}
		}
		return actions;
	};

	var actions_key = "onlyoffice_ai_actions_key";
	AI.ActionsSave = function()
	{
		try
		{
			// exclude external models
			let excludeMap = Object.create(null);
			for (let key in AI.Actions) {
				if (AI.Actions[key].model.startsWith(AI.externalModelPrefix)) {
					excludeMap[key] = AI.Actions[key].model;
					AI.Actions[key].model = "";
				}
			}

			window.localStorage.setItem(actions_key, JSON.stringify(AI.Actions));
			
			// restore excluded
			for (let key in excludeMap) {
				AI.Actions[key].model = excludeMap[key];
			}
			return true;
		}
		catch (e)
		{
		}		
		return false;
	};

	AI.ActionsLoad = function()
	{
		let obj = null;
		try
		{
			if (AI.serverSettings) {
				obj = AI.serverSettings.actions;
			} else {
				obj = JSON.parse(window.localStorage.getItem(actions_key));
			}
		}
		catch (e)
		{
			obj = (AI.DEFAULT_SERVER_SETTINGS && AI.DEFAULT_SERVER_SETTINGS.actions) ? AI.DEFAULT_SERVER_SETTINGS.actions : null;
		}
		
		if (obj)
		{
			for (let i in obj)
			{
				if (AI.Actions[i] && obj[i].model)
					AI.Actions[i].model = obj[i].model;
			}
			return true;
		}
		return false;
	};

	AI.ActionsChange = function(id, model)
	{
		if (AI.Actions[id])
		{
			AI.Actions[id].model = model;
			AI.ActionsSave();
		}

		if (Asc.plugin.sendEvent)
			Asc.plugin.sendEvent("ai_onActionsChange", window.getActionsInfo());
	};

	AI.ActionsLoad();
}
