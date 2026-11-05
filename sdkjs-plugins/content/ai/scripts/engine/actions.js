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

// Request types of the plugin (AI.ActionType) and which model each one
// uses (AI.Actions: chat, summarization, translation, text analysis, image
// generation, OCR, vision). The model choice is edited in the settings
// window and stored in localStorage, or comes from the server settings.
(function(window, undefined)
{
	window.AI = window.AI || {};
	var AI = window.AI;

	AI.ActionType = {
		Chat             : "Chat",
		Summarization    : "Summarization",
		Translation      : "Translation",
		TextAnalyze      : "TextAnalyze",
		ImageGeneration  : "ImageGeneration",
		OCR              : "OCR",
		Vision           : "Vision"
	};

	function ActionUI(name, icon, modelId, capabilities) {
		this.name = name || "";
		this.icon = icon || "";
		this.model = modelId || "";
		this.capabilities = (capabilities === undefined) ? AI.CapabilitiesUI.Chat : capabilities;
	}

	// Builds AI.Actions and loads the saved model choice. Called by
	// registerButtons() once the server settings are known.
	AI.ActionsInit = function()
	{
		AI.Actions = Object.create(null);

		AI.Actions[AI.ActionType.Chat]            = new ActionUI("Chatbot", "ask-ai");
		AI.Actions[AI.ActionType.Summarization]   = new ActionUI("Summarization", "summarization");
		AI.Actions[AI.ActionType.Translation]     = new ActionUI("Translation", "translation");
		AI.Actions[AI.ActionType.TextAnalyze]     = new ActionUI("Text analysis", "text-analysis-ai");
		AI.Actions[AI.ActionType.ImageGeneration] = new ActionUI("Image generation", "image-ai", "", AI.CapabilitiesUI.Image);
		AI.Actions[AI.ActionType.OCR]             = new ActionUI("OCR", "ocr", "", AI.CapabilitiesUI.Vision);
		AI.Actions[AI.ActionType.Vision]          = new ActionUI("Vision", "vision-ai", "", AI.CapabilitiesUI.Vision);

		AI.ActionsLoad();
	};

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

})(window);
