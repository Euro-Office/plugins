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

// The "AI" toolbar tab: settings, chatbot, summarization, translation,
// grammar & spelling, document generation from a form (desktop) and the
// custom assistants. window.buttonMainToolbar and window.buttonSettings
// are updated later by code.js.
(function(window, undefined)
{
	// editorVersion: Asc.Library.GetEditorVersion().
	async function register(editorVersion) {
		let buttonMainToolbar = new Asc.ButtonToolbar();
		buttonMainToolbar.text = "AI";

		window.buttonMainToolbar = buttonMainToolbar;

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
			window.AIChatWindow.show();
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
			return window.AIContextMenu.runOneShotAction(window.AIContextMenu.TRANSLATE_ACTION, lang ? lang : "english");
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

	window.AIToolbar = {
		register : register
	};

})(window);
