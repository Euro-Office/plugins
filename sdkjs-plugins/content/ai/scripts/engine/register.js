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
	let editorType = Asc.Editor.getType();

	// ── One-shot actions ───────────────────────────────────────────────────
	// A one-shot action reads the selection, asks the model once and inserts
	// the answer. Fields of an action (see runOneShotAction):
	//   id          provenance action name (aiProvenance.js)
	//   actionType  AI.ActionType: which model the request uses
	//   input       "text" (selected text, default), "textOrWord" (selected
	//               text, else the word at the cursor) or "image"
	//   required    do nothing when the input is empty
	//   request     ONE_SHOT_REQUESTS key, default "chat"
	//   prompt      (input, data) => prompt; data is the menu item's data
	//   transform   (answer, input) => text to insert
	//   accept      (answer) => false to insert nothing
	//   insert      ONE_SHOT_INSERTS key: how the answer goes into the file
	// The Asc.Library insert methods are looked up on every call: aiEdits.js
	// wraps them to group and track the change, and the provenance meta
	// argument marks the inserted content.

	function singleNewlines(text) {
		return text.replace(/\n\n/g, '\n');
	}

	const ONE_SHOT_REQUESTS = {
		chat   : function(engine, prompt) { return engine.chatRequest(prompt); },
		image  : function(engine, prompt, input) { return engine.imageGenerationRequest(input); },
		ocr    : function(engine, prompt, input) { return engine.imageOCRRequest(input); },
		vision : function(engine, prompt, input) { return engine.imageVisionRequest({ prompt : prompt, image : input }); }
	};

	const ONE_SHOT_INSERTS = {
		text         : function(result, meta) { return Asc.Library.InsertAsText(result, meta); },
		paste        : function(result, meta) { return Asc.Library.PasteText(result, meta); },
		comment      : function(result, meta) { return Asc.Library.InsertAsComment(result, meta); },
		hyperlink    : function(result, meta) { return Asc.Library.InsertAsHyperlink(result, undefined, meta); },
		replaceSmart : function(result, meta) { return Asc.Library.ReplaceTextSmart([result], meta); },
		md           : function(result, meta) { return Asc.Library.InsertAsMD(result, undefined, meta); },
		mdMath       : function(result, meta) { return Asc.Library.InsertAsMD(result, [Asc.PluginsMD.latex, Asc.PluginsMD.hr], meta); },
		// The generated image, as an OLE object that keeps the prompt (a
		// plain image in PDF).
		image        : function(result, meta, input) {
			if (Asc.plugin.info.editorSubType === "pdf")
				return Asc.Library.AddGeneratedImage(result, meta);
			return Asc.Library.AddOleObject(result, input, meta);
		}
	};

	async function readOneShotInput(kind) {
		switch (kind) {
			case "image":
				return await Asc.Library.GetSelectedImage();
			case "textOrWord":
				return (await Asc.Library.GetSelectedText()) || (await Asc.Library.GetCurrentWord());
			default:
				return await Asc.Library.GetSelectedText();
		}
	}

	async function runOneShotAction(action, data) {
		let requestEngine = AI.Request.create(action.actionType);
		if (!requestEngine)
			return;

		let input = await readOneShotInput(action.input);
		if (action.required && !input) {
			if (action.emptyMessage)
				console.log(action.emptyMessage);
			return;
		}

		let prompt = action.prompt ? action.prompt(input, data) : undefined;
		let result = await ONE_SHOT_REQUESTS[action.request || "chat"](requestEngine, prompt, input);
		if (!result)
			return;

		if (action.transform)
			result = action.transform(result, input);
		if (action.accept && !action.accept(result))
			return;

		await ONE_SHOT_INSERTS[action.insert](result, provMeta(action.id, requestEngine), input);
	}

	const TRANSLATE_ACTION = {
		id         : "translate",
		actionType : AI.ActionType.Translation,
		required   : true,
		prompt     : function(text, lang) { return Asc.Prompts.getTranslatePrompt(text, lang); },
		transform  : function(result, text) { return Asc.Library.getTranslateResult(result, text); },
		insert     : "paste"
	};

	const TEXT_IS_CORRECT = 'The text is correct, there are no errors in it.';

	// ── Context menu ───────────────────────────────────────────────────────
	// Built in this order. An entry with `submenu` is a submenu that later
	// entries name as `parent`. An entry with `actionType` runs as a one-shot
	// action; other entries have their own `onClick`. `when` skips an entry
	// (and so its items). Without `editors` a button keeps the SDK default
	// (word, cell, slide).
	const isNotPdf = function() { return editorType !== "pdf"; };

	const CONTEXT_MENU = [
		{ submenu: "grammar", text: "Grammar & Spelling", icon: "grammar", editors: ["word"], checkers: ["Target", "Selection"],
			when: function() { return editorVersion >= 9002000 && isNotPdf(); } },
		{ parent: "grammar", text: "Check all", editors: ["word"], checkers: ["Target", "Selection"],
			onClick: function() { onCheckGrammarSpelling(false); } },
		{ parent: "grammar", text: "Check current text", editors: ["word"], checkers: ["Target", "Selection"],
			onClick: function() { onCheckGrammarSpelling(true); } },

		{ id: "summarization", text: "Summarization", icon: "summarization", editors: ["word"], checkers: ["Selection"], when: isNotPdf,
			actionType: AI.ActionType.Summarization,
			prompt: function(text) { return Asc.Prompts.getSummarizationPrompt(text); },
			transform: function(result) { return "Summary:\n\n" + result; },
			insert: "text" },

		{ submenu: "textAnalysis", text: "Text analysis", icon: "text-analysis-ai", editors: ["word"], checkers: ["Target", "Selection"] },
		{ parent: "textAnalysis", id: "rewrite", text: "Rewrite differently", editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getTextRewritePrompt(text); },
			transform: singleNewlines, insert: "paste" },
		{ parent: "textAnalysis", id: "makeLonger", text: "Make longer", editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getTextLongerPrompt(text); },
			transform: singleNewlines, insert: "paste" },
		{ parent: "textAnalysis", id: "makeShorter", text: "Make shorter", editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getTextShorterPrompt(text); },
			transform: singleNewlines, insert: "paste" },
		{ parent: "textAnalysis", id: "explainComment", text: "Explain text in comment", separator: true, editors: ["word"], checkers: ["Target", "Selection"],
			actionType: AI.ActionType.TextAnalyze, input: "textOrWord", required: true,
			prompt: function(text) { return Asc.Prompts.getExplainPrompt(text); },
			transform: singleNewlines, insert: "comment" },
		{ parent: "textAnalysis", id: "explainHyperlink", text: "Explain text in hyperlink", separator: true, editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getExplainAsLinkPrompt(text); },
			transform: singleNewlines, insert: "hyperlink" },
		// "fixSpellingGrammar" is an assistive edit: AIProvenance.EXEMPT_ACTIONS
		// keeps it unmarked (Art. 50(2) standard-editing exception).
		{ parent: "textAnalysis", id: "fixSpellingGrammar", text: "Fix spelling & grammar", separator: true, editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getFixAndSpellPrompt(text); },
			accept: function(result) {
				if (result !== TEXT_IS_CORRECT)
					return true;
				console.log(TEXT_IS_CORRECT);
				return false;
			},
			insert: "replaceSmart" },
		{ parent: "textAnalysis", id: "keywords", text: "Keywords", editors: ["word"], checkers: ["Selection"],
			actionType: AI.ActionType.TextAnalyze,
			prompt: function(text) { return Asc.Prompts.getTextKeywordsPrompt(text); },
			insert: "text" },

		{ submenu: "translate", text: "Translate", icon: "translation", editors: ["word", "slide", "cell"], checkers: ["Selection"] }
	].concat(["English", "French", "German", "Chinese", "Japanese", "Russian", "Korean", "Spanish", "Italian"].map(function(lang) {
		return Object.assign({ parent: "translate", text: lang, data: lang, editors: ["word", "slide", "cell"], checkers: ["Selection"] }, TRANSLATE_ACTION);
	}), [
		{ text: "Show hyperlink content", checkers: ["Hyperlink"],
			onShowExtend: function(options, item) { item.data = options.value; },
			onClick: showHyperlinkContent },

		{ submenu: "image", text: "Image", icon: "image-ai", checkers: ["Selection", "Image", "OleObject"] },
		{ parent: "image", id: "textToImage", text: "Text to Image", checkers: ["Selection"],
			actionType: AI.ActionType.ImageGeneration, required: true, request: "image", insert: "image" },
		{ parent: "image", id: "ocr", text: "OCR", checkers: ["Image", "OleObject"],
			actionType: AI.ActionType.OCR, input: "image", required: true, emptyMessage: "you need to select an image to use ocr",
			request: "ocr", insert: "mdMath" },
		{ parent: "image", id: "imageToText", text: "Image to Text", checkers: ["Image", "OleObject"],
			actionType: AI.ActionType.Vision, input: "image", required: true,
			prompt: function() { return Asc.Prompts.getImageDescription(); },
			request: "vision", insert: "md" }
	], smartActionsMenu(), [
		{ text: "Chatbot", separator: true, icon: "ask-ai", checkers: ["All"],
			onClick: async function() {
				let selectedText = await Asc.Library.GetSelectedText();
				chatWindowShow(selectedText);
			} }
	]);

	// Smart actions: context-aware agent tasks for the current selection.
	// Each one hands a prompt to the chat agent, which sees the selection
	// (see DocumentContext) and can read/modify the document through tools.
	// Their table is scripts/helpers/smartActions.js (shared with the chat
	// chips); only the menu items are built here.
	function smartActionsMenu() {
		let actions = (isNotPdf() && window.SmartActions) ? window.SmartActions.all(editorType) : [];
		if (!actions.length)
			return [];
		let entries = [{ submenu: "smart", text: "Smart actions", icon: "ask-ai", editors: [editorType], checkers: ["Selection"] }];
		actions.forEach(function(action) {
			entries.push({ parent: "smart", text: action.text, editors: [editorType], checkers: ["Selection"],
				onClick: function() { chatWindowShow(action.prompt + window.SmartActions.LANG_HINT, true); } });
		});
		entries.push({ parent: "smart", text: "Ask about selection...", separator: true, editors: [editorType], checkers: ["Selection"],
			onClick: function() { chatWindowShow(Asc.plugin.tr("About the selection:") + " ", false); } });
		return entries;
	}

	function showHyperlinkContent(data) {
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
	}

	function buildContextMenu(root, entries) {
		let submenus = { "": root };
		entries.forEach(function(entry) {
			let parent = submenus[entry.parent || ""];
			if (!parent || (entry.when && !entry.when()))
				return;
			let button = new Asc.ButtonContextMenu(parent);
			button.text = entry.text;
			if (entry.icon)
				button.icons = getContextMenuButtonIcons(entry.icon);
			if (entry.editors)
				button.editors = entry.editors;
			if (entry.separator)
				button.separator = true;
			if (entry.data)
				button.data = entry.data;
			button.addCheckers.apply(button, entry.checkers);
			if (entry.onShowExtend)
				button.onContextMenuShowExtendItem = entry.onShowExtend;
			if (entry.actionType)
				button.attachOnClick(function(data) { return runOneShotAction(entry, data); });
			else if (entry.onClick)
				button.attachOnClick(entry.onClick);
			if (entry.submenu)
				submenus[entry.submenu] = button;
		});
	}

	buildContextMenu(buttonMain, CONTEXT_MENU);

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

	let buttonChatToolbar = new Asc.ButtonToolbar(buttonMainToolbar);

	if (!AI.serverSettings)
		buttonChatToolbar.separator = true;
	
	buttonChatToolbar.text = "Chatbot";
	buttonChatToolbar.icons = getToolBarButtonIcons("ask-ai");
	buttonChatToolbar.attachOnClick(function(data){
		chatWindowShow();
	});

	if (Asc.Editor.getType() !== "pdf") {
		let buttonSummaryToolbar = new Asc.ButtonToolbar(buttonMainToolbar);
		buttonSummaryToolbar.text = "Summarization";
		buttonSummaryToolbar.icons = getToolBarButtonIcons("summarization");
		buttonSummaryToolbar.attachOnClick(async function(data){
			let requestEngine = AI.Request.create(AI.ActionType.Summarization);
			if (!requestEngine)
				return;

			onOpenSummarizationModal();
		});
	}

	let buttonTranslateToolbar = new Asc.ButtonToolbar(buttonMainToolbar);
	buttonTranslateToolbar.text = "Translation";
	buttonTranslateToolbar.icons = getToolBarButtonIcons("translation");
	buttonTranslateToolbar.menu = [{
			text:'Settings',
			id:'t10n-settings',
			onclick: () => {
				onTranslateSettingsModal();
			}}];
	buttonTranslateToolbar.split = true;
	buttonTranslateToolbar.attachOnClick(function(){
		let lang = window.localStorage.getItem("onlyoffice_ai_plugin_translate_lang");
		return runOneShotAction(TRANSLATE_ACTION, lang ? lang : "english");
	});

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
