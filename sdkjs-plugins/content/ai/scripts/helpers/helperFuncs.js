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

function RegisteredFunction(obj)
{
	this.name = obj.name || "";
	this.description = obj.description || "";
	this.parameters = obj.parameters || {};
	this.examples = obj.examples || [];
	this.returns = obj.returns || {};
	// Read-only tools only inspect the document and run without asking the
	// user. Everything else needs approval. Not sent to providers.
	this.readOnly = obj.readOnly === true;
	// Tool group used to send only relevant tools per request
	// (see toolCategories.js). Not sent to providers.
	this.category = obj.category || "";

	this.call = null;
}

function EditorHelperImpl() {

	this.funcs = [];
	this.names2funcs = {};
	this.names2text = {};
	this.isSupportStreaming = false;

	let editorType = Asc.Editor.getType();

	if (editorType === "word") {
		this.isSupportStreaming = true;
	}

	let hs = [];

	switch (editorType) {
		case "word": {
			hs = HELPERS.word;
			break;
		}
		case "cell": {
			hs = HELPERS.cell;	
			break;
		}
		case "slide": {
			hs = HELPERS.slide;
			break;
		}
		default:
			break;
	}

	for (let i = 0, len = hs.length; i < len; i++) {
		if (Array.isArray(hs[i])) {
			for (let j = 0, len2 = hs[i].length; j < len2; j++)
				this.funcs.push(hs[i][j]);
		} else {
			this.funcs.push(hs[i]);
		}
	}

	if (this.funcs.length > 0)
		this.funcs.push(createLoadToolsFunction(this));

	for (let i = 0; i < this.funcs.length; i++) {
		let func = this.funcs[i];
		this.names2funcs[func.name] = func;
	}

	if (HELPERS.names && HELPERS.names[editorType]) {
		for (let name in HELPERS.names[editorType]) {
			this.names2text[name] = HELPERS.names[editorType][name];
		}
	}
	this.names2text["loadTools"] = "Load Tools";

	// Per category-set caches (key: sorted category list).
	this._toolsCache = {};
	this._systemPromptCache = {};
	// Set by the agent loop for the running turn (see createToolSession);
	// loadTools adds categories to it.
	this.activeToolSession = null;
}

// ── Tool categories ─────────────────────────────────────────────────────
// The meta tool that lets the model fetch more tool categories mid-turn.
// Read-only (runs without approval); it only changes which tool schemas
// the agent loop sends in the following iterations of this turn.
function createLoadToolsFunction(helper) {
	let available = helper.getAvailableCategories();
	let func = new RegisteredFunction({
		"name": "loadTools",
		"category": "meta",
		"readOnly": true,
		"description": "Loads additional tool categories. Only some tools are available at first; call this when you need a tool from another category, then use the new tools in your next step. Categories:\n" + ToolCategories.describe(available),
		"parameters": {
			"type": "object",
			"properties": {
				"categories": {
					"type": "array",
					"items": { "type": "string", "enum": available },
					"description": "Categories to load."
				}
			},
			"required": ["categories"]
		},
		"examples": [
			{
				"prompt": "Add a bar chart of this data",
				"arguments": { "categories": ["charts-visuals"] }
			}
		]
	});

	func.call = async function(params) {
		let requested = params && params.categories;
		if (typeof requested === "string")
			requested = [requested];
		if (!Array.isArray(requested) || requested.length === 0)
			throw new ToolArgumentsError('Parameter "categories" must be a non-empty array. Available: ' + available.join(", "));
		let unknown = requested.filter(function(c) { return available.indexOf(c) === -1; });
		if (unknown.length > 0)
			throw new ToolArgumentsError("Unknown categories: " + unknown.join(", ") + ". Available: " + available.join(", "));

		let session = helper.activeToolSession;
		let added = session ? session.add(requested) : [];
		let names = helper.getToolNames(requested);
		return {
			loaded: requested,
			newlyAvailableTools: session ? helper.getToolNames(added) : names,
			allTools: names
		};
	};
	return func;
}

// Categories this editor has tools for (without the meta category).
EditorHelperImpl.prototype.getAvailableCategories = function() {
	let list = [];
	for (let i = 0; i < this.funcs.length; i++) {
		let cat = this.funcs[i].category;
		if (cat && cat !== ToolCategories.META_CATEGORY && list.indexOf(cat) === -1)
			list.push(cat);
	}
	return ToolCategories.normalize(list);
};

// A tool is part of a selection if its category is selected. Tools without
// a category (e.g. newly added ones) are always sent so they stay reachable.
EditorHelperImpl.prototype._isFuncSelected = function(func, categories) {
	if (func.category === ToolCategories.META_CATEGORY)
		return true;
	if (!func.category)
		return true;
	return categories.indexOf(func.category) !== -1;
};

// Without categories: all tools except loadTools (old behaviour).
EditorHelperImpl.prototype._getSelectedFuncs = function(categories) {
	let result = [];
	for (let i = 0; i < this.funcs.length; i++) {
		let func = this.funcs[i];
		if (!categories) {
			if (func.category !== ToolCategories.META_CATEGORY)
				result.push(func);
		} else if (this._isFuncSelected(func, categories)) {
			result.push(func);
		}
	}
	return result;
};

EditorHelperImpl.prototype.getToolNames = function(categories) {
	let names = [];
	for (let i = 0; i < this.funcs.length; i++) {
		let func = this.funcs[i];
		if (func.category && categories.indexOf(func.category) !== -1)
			names.push(func.name);
	}
	return names;
};

EditorHelperImpl.prototype.getCategoriesOfTools = function(toolNames) {
	let list = [];
	for (let i = 0; toolNames && i < toolNames.length; i++) {
		let func = this.names2funcs[toolNames[i]];
		if (func && func.category && func.category !== ToolCategories.META_CATEGORY && list.indexOf(func.category) === -1)
			list.push(func.category);
	}
	return list;
};

// options: { text, context, usedTools } → normalized category list.
EditorHelperImpl.prototype.selectCategories = function(options) {
	options = options || {};
	return ToolCategories.select({
		editorType: Asc.Editor.getType(),
		text: options.text || "",
		context: options.context || null,
		usedCategories: this.getCategoriesOfTools(options.usedTools || []),
		available: this.getAvailableCategories()
	});
};

// The tool set of one agent turn. Starts with the inferred categories;
// loadTools adds more. The loop polls consumeChanged() after tool calls.
EditorHelperImpl.prototype.createToolSession = function(options) {
	let helper = this;
	let available = this.getAvailableCategories();
	let session = {
		categories: this.selectCategories(options),
		changed: false,
		add: function(categories) {
			let added = categories.filter(function(c) {
				return available.indexOf(c) !== -1 && session.categories.indexOf(c) === -1;
			});
			if (added.length > 0) {
				session.categories = ToolCategories.normalize(session.categories.concat(added), available);
				session.changed = true;
			}
			return added;
		},
		consumeChanged: function() {
			let changed = session.changed;
			session.changed = false;
			return changed;
		},
		getTools: function() {
			return helper.getTools(session.categories);
		},
		getSystemPrompt: function() {
			return helper.getSystemPrompt(session.categories);
		}
	};
	this.activeToolSession = session;
	return session;
};

EditorHelperImpl.prototype._getEditorContext = function() {
	let editorType = Asc.Editor.getType();
	if (editorType === "word") {
		return {
			type: "word",
			name: "text document",
			apiName: "Document API",
			macroExample: "Api.GetDocument().GetElement(0).GetText()",
			readTools: "readDocument, readOutline, findText, getSelection"
		};
	} else if (editorType === "cell") {
		return {
			type: "cell",
			name: "spreadsheet",
			apiName: "Spreadsheet API",
			macroExample: "Api.GetActiveSheet().GetRange(\"A1\").GetValue()",
			readTools: "getWorkbookInfo, readRange, findInSheet"
		};
	} else if (editorType === "slide") {
		return {
			type: "slide",
			name: "presentation",
			apiName: "Presentation API",
			macroExample: "Api.GetPresentation().GetSlidesCount()",
			readTools: "readPresentation, findInPresentation"
		};
	}
	return { type: editorType, name: editorType, apiName: "API", macroExample: "", readTools: "writeMacro" };
};

EditorHelperImpl.prototype.getToolsSystemPrompt = function() {
	if (this.funcs.length === 0)
		return "";

	let ctx = this._getEditorContext();

	let prompt = "\
You are an AI assistant integrated into the OnlyOffice " + ctx.name + " editor.\n\
You have access to tools that can interact with the " + ctx.name + " content.\n\
\n\
IMPORTANT RULES FOR DOCUMENT OPERATIONS:\n\
\n\
1. When the user asks about the " + ctx.name + " content or wants to perform an action on it, you MUST use the available tools.\n\
   Before editing, read what you need with the reading tools (" + ctx.readTools + ") instead of guessing. A snapshot of the user's current selection is included below; use it first.\n\
2. First, check if there is a specialized tool that matches the request (e.g., textStyle, addChart, rewriteText, etc.).\n\
3. If no specialized tool fits, use the \"writeMacro\" tool. It can execute any JavaScript code using the OnlyOffice " + ctx.apiName + ".\n\
4. The \"writeMacro\" tool can also READ/GET data from the " + ctx.name + ". Make the last expression in the code be the value you want to retrieve — it will be returned as the tool result. Example: " + ctx.macroExample + "\n\
5. If a \"writeMacro\" call returns an error, analyze the error message, fix the code, and retry. You may retry up to 5 times for a single macro request before giving up and informing the user.\n\
6. If the user’s question is NOT about the " + ctx.name + " content (e.g., general knowledge, coding help, conversation), respond normally without calling any tools.\n\
7. Only some tools are loaded. If you need a tool that is not available (e.g. charts, conditional formatting, sorting), call \"loadTools\" with the needed categories first instead of falling back to writeMacro.\n\
\n\
Always prefer specialized tools over writeMacro when available. Use writeMacro as a universal fallback for any " + ctx.name + " operation.\n\
";

	return prompt;
};

// categories: optional list from selectCategories(); only those functions
// are described. Cached per category set.
EditorHelperImpl.prototype.getSystemPrompt = function(categories) {
	if (this.funcs.length === 0)
		return "";

	let cacheKey = categories ? categories.join(",") : "*";
	if (this._systemPromptCache[cacheKey])
		return this._systemPromptCache[cacheKey];

	let ctx = this._getEditorContext();
	let funcs = this._getSelectedFuncs(categories);

	let systemPrompt = "\
You are an AI assistant integrated into the OnlyOffice " + ctx.name + " editor with function-calling capabilities.\n\
\n\
BEHAVIOR RULES:\n\
- When the user asks about the " + ctx.name + " content or wants to perform an action on it, you MUST call an appropriate function.\n\
- First, check if there is a specialized function that matches the request.\n\
- If no specialized function fits, use the \"writeMacro\" function. It can execute any JavaScript code using the OnlyOffice " + ctx.apiName + ".\n\
- The \"writeMacro\" function can also READ/GET data from the " + ctx.name + ". Make the last expression in the code be the value you want to retrieve — it will be returned as the function result. Example: " + ctx.macroExample + "\n\
- If a \"writeMacro\" call returns an error, analyze the error message, fix the code, and retry. You may retry up to 5 times for a single macro request before giving up.\n\
- If the user’s question is NOT about the " + ctx.name + " content (e.g., general knowledge, coding help, conversation), respond normally in text without calling any function.\n\
- Do not ask for clarification when a function can handle the request — make reasonable assumptions.\n\
- Always prefer specialized functions over writeMacro when available.\n\
- Only some functions are listed. If you need one from another category, call \"loadTools\" first; the list is then extended.\n\
\n\
────────────────────────────\n\
FUNCTION CALL FORMAT\n\
────────────────────────────\n\
When a function call is required, respond EXACTLY as follows (no other text before or after):\n\
\n\
[functionCalling (functionName)]: parameters\n\
\n\
Where:\n\
- functionName — the exact function name.\n\
- parameters — a valid JSON object of arguments.\n\
\n\
────────────────────────────\n\
RULES\n\
────────────────────────────\n\
- If the user’s request can be handled by any available function — CALL IT.\n\
- If information is incomplete — make reasonable assumptions or leave optional fields empty.\n\
- Do not add punctuation after the JSON.\n\
- Function calls must strictly follow the required format.\n\
- If no function applies, then and only then respond normally in text.\n\
\n\
────────────────────────────\n\
AVAILABLE FUNCTIONS\n\
────────────────────────────\n\
";

	for (let i = 0; i < funcs.length; i++) {
		let func = funcs[i];
		systemPrompt += "\n\
- " + func.name + "\n\
Description: " + func.description + "\n\
Parameters schema:\n" +
JSON.stringify(func.parameters.properties) + "\n\
Returns:\n" +
JSON.stringify(func.returns);

		systemPrompt += "\n\n";
	}

	systemPrompt += "\
────────────────────────────\n\
EXAMPLES\n\
────────────────────────────\n\
";

	for (let i = 0; i < funcs.length; i++) {
		let func = funcs[i];
		for (let j = 0, len = func.examples.length; j < len; j++) {
			let ex = func.examples[j];
			systemPrompt += "If the user says: \"" + ex.prompt + "\"\n\
Respond exactly with:\n\
[functionCalling (" + func.name + ")]: " + JSON.stringify(ex.arguments) + "\n";
		}
	}

	systemPrompt += "\
────────────────────────────\n\
FUNCTION EXECUTION RESULTS\n\
────────────────────────────\n\
When you call a function, the system will execute it and return a result message like:\n\
- \"Function executed successfully\" with optional return data — the function completed successfully\n\
- Or an error message if something went wrong\n\
\n\
IMPORTANT:\n\
- When you receive a successful function execution result, use the returned data to answer the user or proceed with the next step.\n\
- If the task is complete, provide a final response to the user.\n\
- If more functions are needed, call the next required function.\n\
- If a writeMacro call fails with an error, analyze the error, fix the code, and call writeMacro again (up to 5 retries per macro request).\n\
- Never repeat the exact same function call with the same arguments after receiving an error — always fix the issue first.\n\
\n\
────────────────────────────\n\
REMINDER\n\
────────────────────────────\n\
If the user’s question is about the " + ctx.name + " content — always use functions (specialized or writeMacro).\n\
If the user’s question is NOT about the " + ctx.name + " — respond normally with clear helpful text.\n\
";

	this._systemPromptCache[cacheKey] = systemPrompt;
	return systemPrompt;
};

// categories: optional list from selectCategories(); without it all tools
// (except loadTools) are returned. Cached per category set; callers get a copy.
EditorHelperImpl.prototype.getTools = function(categories) {
	if (this.funcs.length === 0)
		return null;

	let cacheKey = categories ? categories.join(",") : "*";
	if (this._toolsCache[cacheKey])
		return JSON.parse(this._toolsCache[cacheKey]);

	// Only serialize the schema fields; internal flags (readOnly, category,
	// call) stay local.
	let funcs = this._getSelectedFuncs(categories);
	let tools = [];
	for (let i = 0; i < funcs.length; i++) {
		let func = funcs[i];
		tools.push({
			name: func.name,
			description: func.description,
			parameters: func.parameters,
			examples: func.examples,
			returns: func.returns
		});
	}

	this._toolsCache[cacheKey] = JSON.stringify(tools);
	return JSON.parse(this._toolsCache[cacheKey]);
};

EditorHelperImpl.prototype.isReadOnly = function(funcName) {
	let func = this.names2funcs[funcName];
	return !!(func && func.readOnly);
};

EditorHelperImpl.prototype.getHumanName = function(funcName) {
	let englishName = this.names2text[funcName];
	if (!englishName)
		return funcName;

	// Look up translation from loaded helper translations
	if (AI.helperTranslations && AI.helperTranslations[englishName])
		return AI.helperTranslations[englishName];

	return englishName;
};

var FUNC_CALL_PREFIX_RE = /^\s*\[functionCalling\s*\(\s*([A-Za-z_$][\w$.-]*)\s*\)\s*\]\s*:?/;

// Parses a prompt-based tool call "[functionCalling (name)]: {json}".
// Returns { funcName, args } or { funcName, error }. Never executes anything.
EditorHelperImpl.prototype.parseFuncCall = function(data) {
	data = (typeof data === "string") ? data : "";

	let match = data.match(FUNC_CALL_PREFIX_RE);
	if (!match)
		return { funcName: "", error: "Malformed function call. Expected: [functionCalling (functionName)]: {JSON arguments}" };

	let funcName = match[1];
	let rest = data.substring(match[0].length);
	let braceIndex = rest.indexOf("{");
	if (braceIndex === -1) {
		if (rest.trim() === "")
			return { funcName: funcName, args: {} };
		return { funcName: funcName, error: "Arguments for \"" + funcName + "\" must be a JSON object." };
	}
	if (rest.substring(0, braceIndex).trim() !== "")
		return { funcName: funcName, error: "Unexpected text before the arguments of \"" + funcName + "\". Arguments must be a JSON object." };

	try {
		return { funcName: funcName, args: parseToolArguments(getJsonResult(rest, braceIndex)) };
	} catch (e) {
		return { funcName: funcName, error: "Arguments for \"" + funcName + "\" are not valid JSON (" + e.message + "). Send a strict JSON object: double-quoted keys and strings, no comments, no expressions." };
	}
};

// hooks.beforeCall(funcName, args) -> Promise<boolean>; false means the user declined.
EditorHelperImpl.prototype.callFunc = async function(data, hooks) {
	let parsed = this.parseFuncCall(data);

	try {
		if (parsed.error)
			throw new ToolArgumentsError(parsed.error);

		let func = this.names2funcs[parsed.funcName];
		if (!func)
			throw new ToolArgumentsError("Unknown tool \"" + parsed.funcName + "\". Available tools: " + Object.keys(this.names2funcs).join(", "));

		if (hooks && typeof hooks.beforeCall === "function") {
			let allowed = await hooks.beforeCall(parsed.funcName, parsed.args);
			if (!allowed)
				return { error: TOOL_DECLINED_MESSAGE, declined: true };
		}

		let toolResultMessage = (hooks && typeof hooks.call === "function")
			? await hooks.call(func, parsed.funcName, parsed.args)
			: await func.call(parsed.args);
		if (toolResultMessage)
			toolResultMessage = Asc.plugin.tr("Function executed successfully") + "\n" + JSON.stringify(toolResultMessage);
		else
			toolResultMessage = Asc.plugin.tr("Function executed successfully");

		return { message : toolResultMessage };
	} catch (e) {
		console.error("Tool execution error:", e);
		return {
			error: Asc.plugin.tr("Error:") + "\n" + (e && e.message ? e.message : String(e))
		};
	}
};

var TOOL_DECLINED_MESSAGE = "The user declined this action.";

function ToolArgumentsError(message) {
	this.name = "ToolError";
	this.message = message;
}
ToolArgumentsError.prototype = Object.create(Error.prototype);
ToolArgumentsError.prototype.constructor = ToolArgumentsError;

// Parses model-supplied tool arguments as data. Strict JSON first; then a
// tolerant pass that only fixes harmless issues (raw control characters inside
// strings, trailing commas). Throws on anything else. Never evaluates code.
function parseToolArguments(str) {
	if (str === undefined || str === null)
		return {};
	if (typeof str === "object")
		return str;

	str = String(str).trim();
	if (str === "")
		return {};

	let result;
	try {
		result = JSON.parse(str);
	} catch (strictError) {
		try {
			result = JSON.parse(relaxJson(str));
		} catch (e) {
			throw new Error(strictError.message);
		}
	}

	if (result === null || typeof result !== "object" || Array.isArray(result))
		throw new Error("expected a JSON object");

	return result;
}

function relaxJson(str) {
	let out = "";
	let inString = false;
	let isEscaped = false;
	for (let i = 0; i < str.length; i++) {
		let ch = str[i];
		if (inString) {
			if (isEscaped) {
				isEscaped = false;
				out += ch;
			} else if (ch === "\\") {
				isEscaped = true;
				out += ch;
			} else if (ch === "\"") {
				inString = false;
				out += ch;
			} else if (ch === "\n") {
				out += "\\n";
			} else if (ch === "\r") {
				out += "\\r";
			} else if (ch === "\t") {
				out += "\\t";
			} else if (ch < " ") {
				out += "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
			} else {
				out += ch;
			}
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			// drop trailing comma before } or ]
			let j = i + 1;
			while (j < str.length && /\s/.test(str[j]))
				j++;
			if (str[j] === "}" || str[j] === "]")
				continue;
		}
		out += ch;
	}
	return out;
}

function getJsonResult(responseText, startPos) {
		
	let result = "";

	let isEscaped = false;
	let inString = false;
	let braceCount = 0;
	let inputLen = responseText.length;
	
	for (let i = startPos; i < inputLen; i++) {
		let char = responseText[i];
		
		if (char === '"' && !isEscaped) {
			inString = !inString;
		}
		
		isEscaped = (char === '\\' && !isEscaped);
		
		if (!inString) {
			if (char === '{') {
				braceCount++;
			}
			else if (char === '}') {
				braceCount--;

				if (braceCount === 0) {
					return responseText.substring(startPos, i + 1);
				}
			}				
		}
	}

	return responseText.substring(startPos);
}
