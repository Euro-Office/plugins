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

// Prompt-based tool calling, for models without native tool support.
//
// Such a model is told in the system prompt (EditorHelper, "FUNCTION CALL
// FORMAT") to answer with one call per reply:
//     [functionCalling (toolName)]: {JSON arguments}
// and gets the result back as a user message starting with "SYSTEM: ".
// Some models write a sentence first and the call on a later line; the call
// counts wherever a line starts with it, and the text before it is a reply.
//
// This adapter lets the agent loop (agentLoop.js) handle these calls on the
// same path as native ones:
//   - toToolCalls() turns such a reply into OpenAI-style tool_calls (one
//     call; a malformed call keeps its parse error in `argumentsError`);
//   - callMessages() / resultMessage() give the messages this format needs:
//     the reply as an assistant message, then the result as a
//     "SYSTEM: ..." user message;
//   - toolCallEvent() is the onToolCallStart/End payload for the chat UI
//     (type "system_prompt", with the raw call text).
// Arguments are parsed as data (EditorHelper.parseFuncCall), never run.
(function(window, undefined)
{
	const CALL_PREFIX = "[functionCalling";
	const CALL_LINE_RE = /(^|\n)[ \t\r]*\[functionCalling/;
	const NEXT_CALL_LINE_RE = /\n[ \t\r]*\[functionCalling/;

	// Index of the line holding the call, or -1.
	function findCall(content) {
		if (typeof content !== "string")
			return -1;
		let match = CALL_LINE_RE.exec(content);
		return match ? match.index + match[1].length : -1;
	}

	// How much of a partial streamed reply can be shown: everything except a
	// call and a last line that may still turn into one.
	function streamableLength(content) {
		let callStart = findCall(content);
		if (callStart !== -1)
			return callStart;
		let lastLine = content.lastIndexOf("\n") + 1;
		return CALL_PREFIX.startsWith(content.substring(lastLine).trimStart()) ? lastLine : content.length;
	}

	function isToolCall(content) {
		return findCall(content) !== -1;
	}

	// The text before the call, shown as a normal reply.
	function textBeforeCall(content) {
		let callStart = findCall(content);
		return callStart > 0 ? content.substring(0, callStart).trim() : "";
	}

	function newCallId() {
		return 'system_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
	}

	// content: the model reply (isToolCall(content) is true).
	function toToolCalls(content) {
		// One call per reply: a second call is left out, not shown as part of the first.
		let callText = content.substring(findCall(content));
		let next = NEXT_CALL_LINE_RE.exec(callText);
		if (next)
			callText = callText.substring(0, next.index);
		let parsed = window.EditorHelper.parseFuncCall(callText);
		let call = {
			id: newCallId(),
			type: "function",
			function: {
				name: parsed.funcName || "",
				arguments: parsed.error ? "" : JSON.stringify(parsed.args || {})
			},
			promptCall: callText
		};
		if (parsed.error)
			call.argumentsError = parsed.error;
		return [call];
	}

	// result: { message } | { error, declined? } of the executed call.
	function resultText(result) {
		if (result.declined)
			return "SYSTEM: " + TOOL_DECLINED_MESSAGE + " Do not repeat this call; continue without it or ask the user how to proceed.";
		if (result.error)
			return "SYSTEM: Function execution failed with error: " + result.error + "\nPlease try a different approach or inform the user about the issue.";
		return "SYSTEM: " + result.message;
	}

	// Messages recording the model's call: the reply itself.
	function callMessages(content, toolCalls) {
		return [{ role: 'assistant', content: content }];
	}

	// Message carrying the result of one executed call back to the model.
	function resultMessage(toolCall, result) {
		return { role: 'user', content: resultText(result) };
	}

	// Payload of onToolCallStart (result undefined) / onToolCallEnd.
	function toolCallEvent(toolCall, result) {
		let event = {
			type: 'system_prompt',
			id: toolCall.id,
			call: toolCall.promptCall
		};
		if (result === undefined) {
			let name = toolCall.function.name;
			event.humanName = name ? window.EditorHelper.getHumanName(name) : '';
		} else {
			event.result = result;
		}
		return event;
	}

	window.AIPromptTools = {
		isToolCall       : isToolCall,
		streamableLength : streamableLength,
		textBeforeCall   : textBeforeCall,
		toToolCalls      : toToolCalls,
		callMessages     : callMessages,
		resultMessage    : resultMessage,
		toolCallEvent    : toolCallEvent
	};

})(window);
