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

// The chat window (chat.html): chatWindowShow() opens it, or activates it
// and attaches text when it is already open. Creates the per-window
// AgentState and handles the window's events: chat messages (handed to the
// agent loop, agentLoop.js), tool approval answers, stop, citation links
// (eo:// locations), "Undo AI changes", applying an answer to the document
// and docking.
(function(window, undefined)
{
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

		// Tool approval: see AIAgentLoop (agentLoop.js) and ToolApproval
		// (toolApproval.js).
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
		chatWindow.attachEvent("onChatMessage", window.AIEdits.wrapChatHandler(function() { return window.chatWindow === chatWindow ? chatWindow : null; }, function(messageHistory) {
			return window.AIAgentLoop.runTurn(chatWindow, AgentState, messageHistory);
		}));
		chatWindow.attachEvent("onChatReplace", async function(data) {
			// Chat answers applied to the document with the message buttons.
			let meta = aiProvenanceMeta("chat:" + data.type, AI.Request.create(AI.ActionType.Chat, true));
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

	window.AIChatWindow = {
		show : chatWindowShow
	};

})(window);
