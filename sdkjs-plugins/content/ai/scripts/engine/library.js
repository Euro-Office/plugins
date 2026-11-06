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

(function(exports, undefined)
{
	let Editor = {};

	// Open "GroupActions" started through Editor.callMethod. sdkjs
	// startGroupActions (common/apiBase.js) sets a global lock on the
	// document, so model requests release them while they wait
	// (AI.Request._wrapRequest, engine.js).
	Editor.openGroupActions = 0;

	// Methods need no dispatcher: the SDK sends one at a time and queues the
	// rest (Asc.plugin.isWaitMethod, executeMethodStack) until the editor
	// answers. The flags are left alone on a timeout: a late answer then
	// reaches the abandoned callback, which ignores it, and the queue moves
	// on. Resetting them would hand that late answer to the next method.
	Editor.callMethod = async function(name, args)
	{
		if (args && args[0] === "GroupActions") {
			if (name === "StartAction")
				Editor.openGroupActions++;
			else if (name === "EndAction" && Editor.openGroupActions > 0)
				Editor.openGroupActions--;
		}
		return withTimeout(new Promise(resolve => (function(){
			Asc.plugin.executeMethod(name, args || [], function(returnValue){
				resolve(returnValue);
			});
		})()), "executeMethod " + name);
	};

	// The editor never answers once it has failed (e.g. "An error occurred
	// during the work with the document"): reject instead of waiting forever,
	// so tools end with an error and the chat turn finishes. The command
	// itself cannot be cancelled and may still run later.
	Editor.TIMEOUT_MS = 60000;

	function withTimeout(promise, what, onTimeout)
	{
		let timer;
		let timeout = new Promise((resolve, reject) => {
			timer = setTimeout(function() {
				if (onTimeout)
					onTimeout();
				reject(new Error("The editor didn't answer in time (" + what + "); the change may still be applied."));
			}, Editor.TIMEOUT_MS);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	// The plugin SDK keeps one callback slot for commands
	// (Asc.plugin.onCallCommandCallback, cleared on every answer), while the
	// editor answers commands one by one in the order they were sent
	// (CPluginsManager.queueCommands, sdkjs common/plugins.js). Every command
	// therefore goes through one dispatcher that matches answers to calls:
	// by the call id the wrapped command returns, or, for answers without
	// one (the editor drops the return value of a command it could not run),
	// to the oldest outstanding call. Answers of calls that timed out are
	// dropped instead of reaching a newer call.
	let commandCalls = [];
	let nextCommandId = 0;

	function onCommandAnswer(returnValue)
	{
		let id = (returnValue && typeof returnValue === "object") ? returnValue.eoCallId : undefined;
		let index = (id === undefined) ? 0 : commandCalls.findIndex(call => call.id === id);
		if (index >= 0 && commandCalls.length) {
			let call = commandCalls.splice(0, index + 1)[index];
			if (call.resolve)
				call.resolve(returnValue);
		}
		if (commandCalls.length)
			Asc.plugin.onCallCommandCallback = onCommandAnswer;
	}

	// sdkjs swallows exceptions thrown inside a command and returns
	// undefined (common/macros.js safePluginEval), which callers cannot tell
	// apart from a command without a return value. The command is wrapped so
	// an exception comes back as a marker: it is recorded in the error scope
	// of the running tool (Editor.runIsolated; AgentLoop turns a tool that
	// caused one into an error) and undefined is returned as before.
	// options.recalculate: false skips the recalculation after the command;
	// options.background: true keeps errors out of the running tool's scope
	// (e.g. selection probes that are not part of a tool).
	Editor.lastCommandError = "";
	Editor.errorScope = null;

	Editor.callCommand = async function(func, options)
	{
		options = options || {};
		let id = ++nextCommandId;
		let source = func.toString();
		let wrapped = { toString: function() {
			return "function() { try { return { eoCallId: " + id + ", value: (" + source + ")() }; } catch (e) { return { eoCallId: " + id + ", eoCommandError: String(e && e.message ? e.message : e) }; } }";
		} };
		let call = { id: id, resolve: null };
		let answer = new Promise(resolve => { call.resolve = resolve; });
		commandCalls.push(call);
		try {
			Asc.plugin.callCommand(wrapped, false, options.recalculate !== false, onCommandAnswer);
		} catch (e) {
			commandCalls.splice(commandCalls.indexOf(call), 1);
			throw e;
		}
		let scope = options.background ? null : Editor.errorScope;
		let returnValue = await withTimeout(answer, "callCommand", function() { call.resolve = null; });
		if (!returnValue || typeof returnValue !== "object" || returnValue.eoCallId === undefined)
			return undefined;
		if (typeof returnValue.eoCommandError === "string") {
			Editor.lastCommandError = returnValue.eoCommandError;
			if (scope)
				scope.errors.push(returnValue.eoCommandError);
			console.warn("[AI] editor command failed:", returnValue.eoCommandError);
			return undefined;
		}
		return returnValue.value;
	};

	// Runs fn (a tool) alone and collects the errors of the commands it
	// sends: resolves { value, errors }. Tool runs are queued one after the
	// other, so a chat tool and an editor-initiated tool (ToolApproval) never
	// see each other's errors.
	let isolatedRuns = Promise.resolve();

	Editor.runIsolated = function(fn)
	{
		let run = isolatedRuns.then(async function() {
			let scope = { errors: [] };
			Editor.errorScope = scope;
			try {
				return { value: await fn(), errors: scope.errors };
			} finally {
				Editor.errorScope = null;
			}
		});
		isolatedRuns = run.catch(function() {});
		return run;
	};

	Editor.pause = async function(msec)
	{
		return new Promise(resolve => (function(){
			setTimeout(function(){
				resolve();				
			}, msec);
		})());
	};

	Editor.getType = function() {
		if (Asc.plugin.info.editorSubType === "pdf")
			return "pdf";
		return window.Asc.plugin.info.editorType;
	};

	exports.Asc = exports.Asc || {};
	exports.Asc.Editor = Editor;

	function Library() {
		this.version = 0;
	}

	exports.Asc.PluginsMD = {
		latex: function(md) {
			// Inline: $...$
			md.inline.ruler.after("escape", "latex_inline", function(state, silent) {
				let start = state.pos;
				if (state.src[start] !== '$')
					return false;
				if (state.src[start + 1] === '$')
					return false;

				let content = "";
				let end = start + 1;
				while ((end = state.src.indexOf('$', end)) !== -1) {
					if (state.src.charCodeAt(end - 1) === 92/*\\*/) {
						end++;
						continue;
					}
					content = state.src.slice(start + 1, end);
					content = content.trim();
					break;
				}

				if (!content)
					return false;

				if (!silent) {
					let token = state.push("latex_inline", "span", 0);
					token.content = content;
					token.attrs = [["class", "oo-latex-inline"]];
				}
			
				state.pos = end + 1;
				return true;
			});
			md.renderer.rules.latex_inline = function(tokens, idx) {
				return `<span class="oo-latex-inline">${tokens[idx].content}</span>`;
			};
			
			// Block: $$...$$  
			md.block.ruler.before("fence", "latex_block", function(state, startLine, endLine, silent) {
				let startPos = state.bMarks[startLine] + state.tShift[startLine];
				let maxPos = state.eMarks[startLine];
				let line = state.src.slice(startPos, maxPos).trim();
				
				if (!line.startsWith("$$"))
					return false;
				if (silent)
					return true;
				
				let content = "";
				let found = false;
				
				for (let i = startLine + 1; i < endLine; i++) {
					let pos = state.bMarks[i] + state.tShift[i];
					let max = state.eMarks[i];
					let nextLine = state.src.slice(pos, max).trim();

					if (nextLine === "$$") {
						found = true;
						state.line = i + 1;
						break;
					}

					content += nextLine + "\n";
				}
				
				if (!found) return false;
				
				const token = state.push("latex_block", "span", 0);
				token.block = true;
				token.content = content.trim();
				token.attrs = [["class", "oo-latex"]];
				token.map = [startLine, state.line];

				return true;
			});
			md.renderer.rules.latex_block = function(tokens, idx) {
				return `<span class="oo-latex">${tokens[idx].content}</span>\n`;
			};
		},

		forms: function(md) {
			let fieldCounter = 1837335014;
			let fieldKeyCounter = 1;

			function parseField(state, silent) {
				const start = state.pos;
				const max = state.posMax;

				if (state.src.charCodeAt(start) !== 0x7B/*{*/ ||
					state.src.slice(start, start + 7) !== '{FIELD:') {
					return false;
				}

				let pos = start + 7;
				let depth = 1;
				while (pos < max && depth > 0) {
					if (state.src.charCodeAt(pos) === 0x7B) depth++;
					if (state.src.charCodeAt(pos) === 0x7D) depth--;
					pos++;
				}

				if (depth !== 0) return false;

				const content = state.src.slice(start + 7, pos - 1);
				
				if (!silent) {
					const token = state.push('field', '', 0);
					token.content = content;
					token.markup = '{FIELD:}';
				}

				state.pos = pos;
				return true;
			}

			function parseParams(content) {
				const params = {};
				const regex = /(\w+)[:=](?:'([^']*)'|"([^"]*)"|([^,}]*))/g;
				let match;

				while ((match = regex.exec(content)) !== null) {
					const key = match[1];
					const value = match[2] || match[3] || match[4];
					params[key] = value;
				}

				return params;
			}

			function renderField(tokens, idx) {
				const params = parseParams(tokens[idx].content);
				const type = params.type;

				switch (type) {
					case 'checkbox':
						return renderCheckbox(params);
					case 'radiobutton':
						return renderRadiobutton(params);
					case 'combobox':
						return renderCombobox(params);
					case 'textbox':
						return renderTextbox(params);
					case 'date':
						return renderDate(params);
					default:
						return '';
				}
			}

			function renderCheckbox(params) {
				const checked = params.checked === 'true';
				const symbolChecked = params.symbolChecked || '☑';
				const symbolUnchecked = params.symbolUnchecked || '☐';
				const key = params.key || ('Checkbox' + fieldKeyCounter++);
				const text = params.text || '';
				const displaySymbol = checked ? symbolChecked : symbolUnchecked;

				return `<w:Sdt CheckBox="t" Form="t" CheckBoxValueChecked="${symbolChecked}" CheckBoxValueUnchecked="${symbolUnchecked}" Key="${key}" Text="${text}"/></w:Sdt>`;
			}

			function renderRadiobutton(params) {
				const checked = params.checked === 'true';
				const symbolChecked = params.symbolChecked || '◉';
				const symbolUnchecked = params.symbolUnchecked || '○';
				const groupKey = params.groupKey || params.GroupKey || 'Group 1';
				const key = params.key || ('Radio' + fieldKeyCounter++);
				const text = params.text || '';
				const displaySymbol = checked ? symbolChecked : symbolUnchecked;

				return `<w:Sdt CheckBox="t" Form="t" CheckBoxValueChecked="${symbolChecked}" CheckBoxValueUnchecked="${symbolUnchecked}" GroupKey="${groupKey}" Key="${key}" Text="${text}"></w:Sdt>`;
			}

			function renderCombobox(params) {
				const items = params.items ? params.items.split(',') : [];
				const selected = params.selected || '';
				const key = params.key || ('Combobox' + fieldKeyCounter++);
				const id = fieldCounter++;

				let itemsHtml = items.map(item => {
					const trimmed = item.trim();
					return `<w:ListItem ListValue="${trimmed}" DataValue="${trimmed}"></w:ListItem>`;
				}).join('');

				return `<w:Sdt ComboBox="t" Form="t" Key="${key}" ID="${id}">${itemsHtml}\n</w:Sdt>`;
			}

			function renderTextbox(params) {
				const key = params.key || ('Textbox' + fieldKeyCounter++);
				const text = params.text || params.value || '';
				const placeholder = params.placeholder || '';

				if (placeholder === "" && text === "")
					text = "empty";
				
				if (placeholder === "")
					return `<w:Sdt Form="t" Key="${key}">${text}</w:Sdt>`;
				else
					return `<w:Sdt Form="t" Key="${key}" PlcHdr="${placeholder}" ShowingPlcHdr="t">${text}</w:Sdt>`;
			}

			function renderDate(params) {
				const key = params.key || ('DatePicker' + fieldKeyCounter++);
				const value = params.value || '';
				
				let isoDate = '';
				let displayDate = value;
			
				if (value) {
					const parts = value.split('.');
					if (parts.length === 3) {
						isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
						displayDate = value;
					}
				}
				return `<w:Sdt Calendar="t" Form="t" MapToDateTime="t" CalendarType="Gregorian" Date="${isoDate}" DateFormat="dd.MM.yyyy" Key="${key}">${displayDate}</w:Sdt>`;
			}

			md.inline.ruler.before('emphasis', 'field', parseField);
			md.renderer.rules.field = renderField;
		},

		hr: function(md) {
			md.renderer.rules.hr = function() {
				return '<hr><br>';
			};
		}
	};

	function decodeHtmlText(text) {
		return text
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')			
			.replace(/&nbsp;/g, ' ');
	}

	// Provenance (scripts/helpers/aiProvenance.js): the insert methods below
	// take an optional `meta` ({ action, provider, model }, see
	// AIProvenance.meta). With it, AI text inserted into a text document is
	// wrapped in "ai-generated" content controls and the action is recorded
	// in the document properties. Without it nothing is marked (callers that
	// mark on their own, e.g. agent tools, which the agent loop records).
	function provenance(meta) {
		return (meta && window.AIProvenance) ? window.AIProvenance : null;
	}

	async function provenanceBefore(meta) {
		let p = provenance(meta);
		return p ? await p.captureAnchor(meta) : null;
	}

	async function provenanceAfter(meta, anchor, inserted) {
		let p = provenance(meta);
		if (!p)
			return;
		if (anchor)
			await p.markInsertion(anchor, inserted);
		await p.record(meta);
	}

	Library.prototype.GetEditorVersion = async function()
	{
		if (this.version !== 0)
			return this.version;

		let version = await Editor.callMethod("GetVersion");
		if ("develop" == version)
			version = "99.99.99";

		let arrVer = version.split(".");
		while (3 > arrVer.length)
			arrVer.push("0");

		this.version = 1000000 * parseInt(arrVer[0]) +  1000 * parseInt(arrVer[1]) + parseInt(arrVer[2]);
		return this.version;
	};

	Library.prototype.GetCurrentWord = async function()
	{
		return await Editor.callMethod("GetCurrentWord");
	};

	Library.prototype.GetSelectedText = async function()
	{
		let result = await Editor.callMethod("GetSelectedText");
		if (result !== "")
			return result;

		return this.GetSelectedContent("text");
	};

	Library.prototype.GetSelectedContent = async function(type) {
		return await Editor.callMethod("GetSelectedContent", [{ type : type }]);
	};

	Library.prototype.GetSelectedImage = async function(type) {
		let res = await Editor.callMethod("GetSelectedContent", [{ type : "html" }]);
		let index1 = res.indexOf("src=\"data:image/");
		if (-1 === index1)
			return "";
		index1 += 5;
		let index2 = res.indexOf("\"", index1);
		if (-1 === index2)
			return "";
		return res.substring(index1, index2);
	};

	Library.prototype.ReplaceTextSmart = async function(text, meta)
	{
		let anchor = await provenanceBefore(meta);
		let result = await Editor.callMethod("ReplaceTextSmart", [text]);
		await provenanceAfter(meta, anchor, { text: Array.isArray(text) ? text.join("\n") : String(text || "") });
		return result;
	};

	Library.prototype.InsertAsText = async function(text, meta)
	{
		Asc.scope.data = (text || "").split("\n\n");
		// Appended paragraphs are built here, so they go straight into one
		// block-level "ai-generated" content control.
		let p = provenance(meta);
		Asc.scope.aiCC = p ? p.cc(meta) : null;
		let result = await Editor.callCommand(function() {
			let oDocument = Api.GetDocument();
			let cc = Asc.scope.aiCC;
			let sdt = null;
			if (cc && typeof Api.CreateBlockLvlSdt === "function") {
				sdt = Api.CreateBlockLvlSdt();
				sdt.SetTag(cc.tag);
				sdt.SetAlias(cc.alias);
				if (typeof sdt.SetAppearance === "function")
					sdt.SetAppearance("hidden");
			}
			let count = 0;
			for (let ind = 0; ind < Asc.scope.data.length; ind++) {
				let text = Asc.scope.data[ind];
				if (text.length) {
					let oParagraph = Api.CreateParagraph();
					oParagraph.AddText(text);
					if (sdt)
						sdt.AddElement(oParagraph, count);
					else
						oDocument.Push(oParagraph);
					count++;
				}
			}
			if (sdt && count > 0)
				oDocument.Push(sdt);
		});
		Asc.scope.aiCC = null;
		await provenanceAfter(meta, null);
		return result;
	};

	Library.prototype.getHTMLFromMD = function(data, plugins, isStreaming)
	{
		return Asc.Library.ConvertMdToHTML(data, plugins, isStreaming !== false);
	};

	Library.prototype.InsertAsMD = async function(data, plugins, meta)
	{
		let htmlContent = Asc.Library.ConvertMdToHTML(data, plugins);
		return await Asc.Library.InsertAsHTML(htmlContent, meta);
	};

	Library.prototype.ConvertMdToHTML = function(data, plugins, isStreaming)
	{
		let c = window.markdownit();
		if (plugins) {
			for (let i = 0, len = plugins.length; i < len; i++)
				c.use(plugins[i]);
		}
		return c.render(this.getMarkdownResult(data, isStreaming));
	};

	Library.prototype.InsertAsHTML = async function(data, meta)
	{
		switch (Asc.Editor.getType()) {
			case "word": {
				await Editor.callCommand(function() {
					let document = Api.GetDocument();
					document.RemoveSelection();
				}, false);
			}
			default:
				break;
		}
		let anchor = await provenanceBefore(meta);
		let result = await Editor.callMethod("PasteHtml", [data]);
		await provenanceAfter(meta, anchor, { html: data });
		return result;
	};

	// Comments are not document body content: they are not wrapped in
	// content controls, the author name says that the AI wrote them.
	Library.prototype.InsertAsComment = async function(text, meta)
	{
		let result = await Editor.callMethod("AddComment", [{
			UserName : window.AIProvenance ? window.AIProvenance.commentAuthor(meta) : "AI",
			Text : decodeHtmlText(text),
			Time: Date.now(),
			Solver: false
		}]);
		await provenanceAfter(meta, null);
		return result;
	};

	// Only the link target comes from the AI; the linked text is the user's,
	// so it is not wrapped in a content control (the action is recorded).
	Library.prototype.InsertAsHyperlink = async function(content, hint, meta)
	{
		let text = content;
		start = text.indexOf('htt');
		end = text.indexOf(' ', start);
		if (end == -1)
			end = text.length;

		Asc.scope.link = text.slice(start, end);
		let result = await Editor.callCommand(function(){
			let oDocument = Api.GetDocument();
			let oRange = oDocument.GetRangeBySelect();
			oRange.AddHyperlink(Asc.scope.link, "Meaning of the word");
		});
		await provenanceAfter(meta, null);
		return result;
	};

	Library.prototype.InsertAsReview = async function(content, isHtml, meta) 
	{
		let isTrackRevisions = await Editor.callCommand(function(){
			let res = Api.asc_GetLocalTrackRevisions();
			Api.asc_SetLocalTrackRevisions(true);
			return res;
		});

		Asc.scope.localTrackRevisions = isTrackRevisions;

		let anchor = await provenanceBefore(meta);
		await Editor.callMethod(isHtml ? "PasteHtml" : "PasteText", [content.trim()]);
		await provenanceAfter(meta, anchor, isHtml ? { html: content } : { text: content });

		if (true !== isTrackRevisions) 
		{
			await Editor.callCommand(function(){
				Api.asc_SetLocalTrackRevisions(Asc.scope.localTrackRevisions);
			});
		}
	};

	Library.prototype.PasteText = async function(text, meta)
	{
		let anchor = await provenanceBefore(meta);
		let result = await Editor.callMethod("PasteText", [text]);
		await provenanceAfter(meta, anchor, { text: text });
		return result;
	};

	Library.prototype.SendError = async function(text, errorLevel)
	{
		Asc.scope.errorText = text;
		Asc.scope.errorLevel = errorLevel;
		return await Editor.callCommand(function(){
			Api.sendEvent("asc_onError", Asc.scope.errorText, Asc.scope.errorLevel);
		});
	};

	Library.prototype.GetLocalImagePath = async function(url) {
		return await Editor.callMethod("getLocalImagePath", [url]);
	};

	Library.prototype.AddGeneratedImage = async function(base64, meta) {
		let editorVersion = await Asc.Library.GetEditorVersion();
		let p = provenance(meta);
		if (p) {
			// No-op if the image request already embedded the XMP packet.
			base64 = p.markImage(base64, meta);
		}
		// Alt text, where ApiDrawing.SetDescription exists (10.0+).
		Asc.scope.aiAlt = p ? p.altText(meta) : null;
		let result = await this._addGeneratedImage(base64, editorVersion);
		Asc.scope.aiAlt = null;
		await provenanceAfter(meta, null);
		return result;
	};

	Library.prototype._addGeneratedImage = async function(base64, editorVersion) {

		if (Asc.Editor.getType() === "pdf") {
			return await Editor.callMethod("PasteHtml", ["<img src=\"" + base64 + "\" />"]);
		}
		
		if (editorVersion >= 9000000) {
			let urlLocal = await this.GetLocalImagePath(base64);
			if (urlLocal.error === true)
				return;

			Asc.scope.url = urlLocal.url;
		} else {
			Asc.scope.url = url;
		}

		switch (window.Asc.plugin.info.editorType) {
			case "word": {
				return await Editor.callCommand(function() {
					let document = Api.GetDocument();
					let paragraph = Api.CreateParagraph();
					let drawing = Api.CreateImage(Asc.scope.url, 100 * 36000, 100 * 36000);
					if (Asc.scope.aiAlt && typeof drawing.SetDescription === "function")
						drawing.SetDescription(Asc.scope.aiAlt);
					paragraph.AddDrawing(drawing);
					document.RemoveSelection();
					document.InsertContent([paragraph], true);
				}, false);
			}
			case "cell": {
				return await Editor.callCommand(function() {
					let worksheet = Api.GetActiveSheet();
					let image = worksheet.AddImage(Asc.scope.url, 100 * 36000, 100 * 36000, 0, 2 * 36000, 2, 3 * 36000);
					if (image && Asc.scope.aiAlt && typeof image.SetDescription === "function")
						image.SetDescription(Asc.scope.aiAlt);
				}, false);
			}
			case "slide": {
				return await Editor.callCommand(function() {
					let presentation = Api.GetPresentation();
					let slide = presentation.GetCurrentSlide();
					let image = Api.CreateImage(Asc.scope.url, 150 * 36000, 150 * 36000);
					if (Asc.scope.aiAlt && typeof image.SetDescription === "function")
						image.SetDescription(Asc.scope.aiAlt);
					slide.AddObject(image);
				}, false);
			}
			default:
				break;
		}
	};

	Library.prototype.AddOleObject = async function(imageUrl, data, meta) {
		let p = provenance(meta);
		if (p)
			imageUrl = p.markImage(imageUrl, meta);
		let result = await this._addOleObject(imageUrl, data);
		await provenanceAfter(meta, null);
		return result;
	};

	Library.prototype._addOleObject = async function(imageUrl, data) {
		switch (window.Asc.plugin.info.editorType) {
			case "word": {
				await Editor.callCommand(function(){
					let document = Api.GetDocument();
					document.RemoveSelection();
				});
				break;
			}
			default:
				break;
		}

		let W = 100;
		let H = 100;

		let info = window.Asc.plugin.info;
		var obj = {
			guid : info.guid,
			widthPix : info.mmToPx * W,
			heightPix : info.mmToPx * H,
			width : W,
			height : H,
			imgSrc : imageUrl,
			data : data
		};

		return await Editor.callMethod("AddOleObject", [obj]);
	};

	Library.prototype.trimResult = function(data, posStart, isSpaces, extraCharacters) {
		let pos = posStart || 0;
		if (-1 != pos) {
			let trimC = ["\"", "'", "\n", "\r", "`"];
			if (true === isSpaces)
				trimC.push(" ");
			while (pos < data.length && trimC.includes(data[pos]))
				pos++;

			let posEnd = data.length - 1;
			while (posEnd > 0 && trimC.includes(data[posEnd]))
				posEnd--;

			if (posEnd > pos)
				return data.substring(pos, posEnd + 1);				
		}
		return data;
	};

	Library.prototype.getTranslateResult = function(data, dataSrc) {
		data = this.trimResult(data, 0, true);
		let trimC = ["\"", "'", "\n", "\r", " "];
		if (dataSrc.length > 0 && trimC.includes(dataSrc[0])) {
			data = dataSrc[0] + data;
		}
		if (dataSrc.length > 1 && trimC.includes(dataSrc[dataSrc.length - 1])) {
			data = data + dataSrc[dataSrc.length - 1];
		}
		return data;
	};

	Library.prototype.getMarkdownResult = function(data, isStreaming) {
		let markdownEscape = data.indexOf("```md");
		if (-1 !== markdownEscape && markdownEscape < 5)
			data = data.substring(markdownEscape + 5);
		if (data.endsWith("```"))
			data = data.slice(0, -3);
		let correctData = data.replace(/\n---#/g, '\n---\n#');
		return isStreaming ? correctData : this.trimResult(correctData);
	};

	Library.prototype.getJSONResult = function(data) {
		const markdownMarker = "```json";
		let markdownEscape = data.indexOf(markdownMarker);
		if (-1 !== markdownEscape && markdownEscape < 5)
			data = data.substring(markdownEscape + markdownMarker.length);
		return this.trimResult(data);
	};

	exports.Asc = exports.Asc || {};
	exports.Asc.Library = new Library();

	exports.Asc.Prompts = {
		getFixAndSpellPrompt(content) {
			let prompt = `I want you to act as an editor and proofreader. \
I will provide you with some text that needs to be checked for spelling and grammar errors. \
Your task is to carefully review the text and correct any mistakes, \
ensuring that the corrected text is free of errors and maintains the original meaning. \
Only return the corrected text. \
Here is the text that needs revision: \"${content}\"`;
			return prompt;
		},
		getSummarizationPrompt(content, language) {
			let prompt = "Summarize the following text. ";
			if (language) {
				prompt += "and translate the result to " + language;
				prompt += ". Return only the resulting translated text.";
			} else {
				prompt += ". Return only the resulting text.";
			}
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getTranslatePrompt(content, language) {
			let prompt = "Translate the following text to " + language;
			prompt += ". Return only the resulting text.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getExplainPrompt(content) {
			let prompt = "Explain what the following text means. Return only the resulting text.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getTextLongerPrompt(content) {
			let prompt = "Make the following text longer. Return only the resulting text.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getTextShorterPrompt(content) {
			let prompt = "Make the following text simpler. Return only the resulting text.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getTextRewritePrompt(content) {
			let prompt = "Rewrite the following text differently. Return only the resulting text.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getTextKeywordsPrompt(content) {
			let prompt = `Get Key words from this text: "${content}"`;
			return prompt;
		},
		getExplainAsLinkPrompt(content) {
			let prompt = "Give a link to the explanation of the following text. Return only the resulting link.";
			prompt += "Text: \"\"\"\n";
			prompt += content;
			prompt += "\n\"\"\"";
			return prompt;
		},
		getImageDescription() {
			return "Describe in detail everything you see in this image. Mention the objects, their appearance, colors, arrangement, background, and any noticeable actions or interactions. Be as specific and accurate as possible. Avoid making assumptions about things that are not clearly visible."
		},
		getImagePromptOCR() {
			return "Extract all text from this image as accurately as possible. Preserve original reading order and formatting if possible. Recognize tables and images if possible. Do not add or remove any content. Output recognized objects in md format if possible. If not, return plain text.";
		}
	};

})(window);