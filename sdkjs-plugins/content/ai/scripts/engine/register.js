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

// Entry point of the plugin's UI, called once by code.js
// (initWithTranslate) after the translations and the server settings are
// loaded. The parts live in their own files:
//   actions.js      AI.ActionType / AI.Actions: the model of each request type
//   chatWindow.js   the chat window and its events
//   agentLoop.js    the chat agent loop (tool calls, approval, transcripts)
//   promptTools.js  tool calling for models without native tool support
//   contextMenu.js  the "AI" context menu and its one-shot actions
//   toolbar.js      the "AI" toolbar tab
// The helpers below are globals shared by these files.

// Provenance metadata for an AI action (see scripts/helpers/aiProvenance.js).
// Passed to the Asc.Library insert methods, which mark the inserted
// content and record the action in the document properties.
function aiProvenanceMeta(action, requestEngine) {
	return window.AIProvenance ? window.AIProvenance.meta(action, requestEngine) : null;
}

function getToolBarButtonIcons(icon) {
	return "resources/icons/%theme-type%(light|dark)/big/" + icon + "%scale%(default).png";
}

function getContextMenuButtonIcons(icon) {
	return "resources/icons/%theme-type%(light|dark)/" + icon + "%scale%(default).png";
}

async function registerButtons(window, undefined)
{
	window.AI = window.AI || {};
	window.AI.ActionsInit();

	window.chatWindowShow = window.AIChatWindow.show;
	window.getToolBarButtonIcons = getToolBarButtonIcons;

	let editorVersion = await Asc.Library.GetEditorVersion();
	window.AIContextMenu.register(editorVersion);
	await window.AIToolbar.register(editorVersion);
}
