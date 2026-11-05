// SPDX-License-Identifier: AGPL-3.0-only

// Machine-readable marking of AI-generated content (groundwork for
// EU AI Act Art. 50(2): "outputs ... are marked in a machine-readable format
// and detectable as artificially generated or manipulated").
//
// Three layers:
//  1. File level: custom document properties (word, cell, slide), written by
//     record() after every AI action that changes the document:
//       AIGenerated           = true
//       AIGeneratedModels     = "provider/model; provider/model" (deduplicated)
//       AIGeneratedLastUpdate = ISO 8601 timestamp
//       AIGeneratedPolicy     = "EU AI Act Art. 50; machine-readable marking"
//     Needs ApiCustomProperties (editor 9.0+). Older editors are reported in
//     the console and left alone: core properties (title, subject, keywords,
//     ...) belong to the user and are not used as a fallback.
//  2. Text (word only): AI-written text is wrapped in content controls with
//     the tag "ai-generated" and the alias "AI-generated (model, date)",
//     appearance hidden. See captureAnchor()/markInsertion() and cc().
//  3. Images: generated PNG/JPEG get an XMP packet with IPTC
//     DigitalSourceType = trainedAlgorithmicMedia (markImage()), and the
//     inserted drawing gets an alt text "AI-generated image (model)".
//
// Switch: "Mark AI-generated content" in the plugin settings (default on,
// localStorage). Admins can set it in the server settings
// (AI.serverSettings, read only here):
//   "provenance": { "enabled": true|false, "force": true|false }
// "enabled" is the default for users; with "force": true it is enforced and
// the user setting is ignored.
(function(root) {

	const STORAGE_KEY = "onlyoffice_ai_provenance_enabled";
	const TAG = "ai-generated";
	const POLICY = "EU AI Act Art. 50; machine-readable marking";
	const PROPS = {
		generated: "AIGenerated",
		models: "AIGeneratedModels",
		lastUpdate: "AIGeneratedLastUpdate",
		policy: "AIGeneratedPolicy"
	};
	const MODELS_SEPARATOR = "; ";
	const MAX_MODELS = 32;
	const TOOL_NAME = "Euro-Office AI plugin";
	const DIGITAL_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

	// Assistive edits that are NOT marked (no document properties, no content
	// controls). Art. 50(2) does not apply "to the extent the AI systems
	// perform an assistive function for standard editing or do not
	// substantially alter the input data": a spelling/grammar fix keeps the
	// author's text and meaning, so marking it as AI-generated would be
	// misleading. Rewrites, translations, summaries etc. are generated content
	// and are marked. Keys are tool names or action ids passed to record().
	const EXEMPT_ACTIONS = Object.freeze({
		"checkSpelling": true,          // agent tool (word)
		"fixSpellingGrammar": true,     // context menu "Fix spelling & grammar"
		"spellingAnnotation": true,     // accepted spelling suggestion
		"grammarAnnotation": true       // accepted grammar suggestion
	});

	// Actions whose text is recorded in the document properties but not
	// wrapped in content controls: generated forms consist of form fields
	// (content controls themselves), which must not be nested in another one.
	const NO_TEXT_MARK_ACTIONS = Object.freeze({
		"generateForm": true
	});

	// ── Settings ───────────────────────────────────────────────────────────

	function serverConfig() {
		let AI = root.AI;
		let cfg = AI && AI.serverSettings ? AI.serverSettings.provenance : null;
		return (cfg && typeof cfg === "object") ? cfg : null;
	}

	function readUserSetting() {
		try {
			let value = root.localStorage.getItem(STORAGE_KEY);
			if (value === "true")
				return true;
			if (value === "false")
				return false;
		} catch (e) {
		}
		return null;
	}

	function isLocked() {
		let cfg = serverConfig();
		return !!(cfg && cfg.force === true);
	}

	function isEnabled() {
		let cfg = serverConfig();
		if (cfg && cfg.force === true)
			return cfg.enabled !== false;
		let user = readUserSetting();
		if (user !== null)
			return user;
		if (cfg && typeof cfg.enabled === "boolean")
			return cfg.enabled;
		return true;
	}

	function setUserEnabled(value) {
		try {
			root.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
			return true;
		} catch (e) {
			return false;
		}
	}

	function isExempt(action) {
		return !!(action && EXEMPT_ACTIONS[action] === true);
	}

	// ── Model metadata ─────────────────────────────────────────────────────

	// meta: { action, provider, model }
	function meta(action, engine) {
		let res = { action: action || "", provider: "", model: "" };
		if (engine && engine.modelUI) {
			res.provider = engine.modelUI.provider || "";
			res.model = (engine.model && engine.model.id) || engine.modelUI.id || engine.modelUI.name || "";
		}
		return res;
	}

	function modelLabel(m) {
		if (!m)
			return "";
		let model = String(m.model || "").trim();
		let provider = String(m.provider || "").trim();
		if (!model && !provider)
			return "";
		if (!provider)
			return model;
		if (!model)
			return provider;
		return provider + "/" + model;
	}

	function shortModel(m) {
		return (m && (m.model || m.provider)) ? String(m.model || m.provider) : "unknown model";
	}

	function isoDate(d) {
		return (d || new Date()).toISOString().slice(0, 10);
	}

	// Merges model labels into the stored "a; b" list, keeping first-seen
	// order and dropping duplicates/empties. Keeps the newest MAX_MODELS.
	function mergeModels(existing, labels) {
		let list = [];
		let seen = Object.create(null);
		function add(label) {
			label = String(label || "").trim();
			if (!label || seen[label.toLowerCase()])
				return;
			seen[label.toLowerCase()] = true;
			list.push(label);
		}
		String(existing || "").split(";").forEach(add);
		(labels || []).forEach(add);
		if (list.length > MAX_MODELS)
			list = list.slice(list.length - MAX_MODELS);
		return list.join(MODELS_SEPARATOR);
	}

	// ── Tool scope: collects every model used while an agent tool runs ─────
	// (e.g. addImage uses the image model in addition to the chat model).

	let scopes = [];

	function beginScope(primary) {
		let scope = { primary: primary || null, models: [] };
		scopes.push(scope);
		return scope;
	}

	function endScope(scope) {
		let i = scopes.indexOf(scope);
		if (i !== -1)
			scopes.splice(i, 1);
		return scope ? scope.models : [];
	}

	// Called by AI.Request for every request it sends.
	function noteRequest(engine) {
		if (!scopes.length || !engine)
			return;
		scopes[scopes.length - 1].models.push(meta("", engine));
	}

	// Metadata for marks set inside an agent tool: the running tool's name
	// and the agent's model (`action` is used outside of a tool scope).
	function scopeMeta(action) {
		let scope = scopes.length ? scopes[scopes.length - 1] : null;
		let m = scope && scope.primary ? scope.primary : { action: "", provider: "", model: "" };
		return { action: m.action || action || "", provider: m.provider, model: m.model };
	}

	// Runs an agent tool and records it unless the tool only reads.
	async function runTool(funcName, isReadOnly, engine, fn) {
		let primary = meta(funcName, engine);
		let scope = beginScope(primary);
		let result;
		let used;
		try {
			result = await fn();
		} finally {
			used = endScope(scope);
		}
		if (!isReadOnly)
			await record({ action: funcName, provider: primary.provider, model: primary.model, models: used });
		return result;
	}

	// ── 1. File level ──────────────────────────────────────────────────────

	// Writes the custom document properties. Never throws.
	// Returns { ok, reason? }.
	async function record(info) {
		info = info || {};
		if (!isEnabled())
			return { ok: false, reason: "disabled" };
		if (isExempt(info.action))
			return { ok: false, reason: "exempt" };
		if (!root.Asc || !root.Asc.Editor || typeof root.Asc.Editor.callCommand !== "function")
			return { ok: false, reason: "no-editor" };

		let labels = [modelLabel(info)];
		(info.models || []).forEach(function(m) { labels.push(modelLabel(m)); });

		try {
			// The builder Api objects inherit from each other (cell -> slide ->
			// word), so pick the accessor by editor type, not by feature.
			root.Asc.scope.aiProvenanceEditor = root.Asc.Editor.getType();
			let existing = await root.Asc.Editor.callCommand(function() {
				let props = null;
				let owner = null;
				switch (Asc.scope.aiProvenanceEditor) {
					case "word": owner = Api.GetDocument(); break;
					case "slide": owner = Api.GetPresentation(); break;
					case "cell": owner = Api; break;
				}
				if (owner && typeof owner.GetCustomProperties === "function")
					props = owner.GetCustomProperties();
				if (!props || typeof props.Get !== "function" || typeof props.Add !== "function")
					return { supported: false };
				return { supported: true, models: props.Get("AIGeneratedModels") };
			});

			if (!existing || !existing.supported) {
				console.warn("[AIProvenance] Custom document properties are not supported by this editor (needs 9.0+); AI use is not recorded in the file.");
				return { ok: false, reason: "unsupported" };
			}

			root.Asc.scope.aiProvenance = {
				models: mergeModels(typeof existing.models === "string" ? existing.models : "", labels),
				date: new Date().toISOString(),
				policy: POLICY
			};

			await root.Asc.Editor.callCommand(function() {
				let d = Asc.scope.aiProvenance;
				let owner = null;
				switch (Asc.scope.aiProvenanceEditor) {
					case "word": owner = Api.GetDocument(); break;
					case "slide": owner = Api.GetPresentation(); break;
					case "cell": owner = Api; break;
				}
				let props = (owner && typeof owner.GetCustomProperties === "function") ? owner.GetCustomProperties() : null;
				if (!props)
					return;
				props.Add("AIGenerated", true);
				if (d.models)
					props.Add("AIGeneratedModels", d.models);
				props.Add("AIGeneratedLastUpdate", d.date);
				props.Add("AIGeneratedPolicy", d.policy);
			}, false);
			return { ok: true };
		} catch (e) {
			console.error("[AIProvenance] record failed:", e);
			return { ok: false, reason: "error" };
		}
	}

	// ── 2. Text marking (word) ─────────────────────────────────────────────

	function isWord() {
		return !!(root.Asc && root.Asc.Editor && root.Asc.Editor.getType && root.Asc.Editor.getType() === "word");
	}

	function shouldMark(m) {
		return isEnabled() && !isExempt(m && m.action);
	}

	function alias(m) {
		let text = "AI-generated (" + shortModel(m) + ", " + isoDate() + ")";
		return text.length > 120 ? text.slice(0, 117) + "..." : text;
	}

	// Content control properties for code that builds the content itself
	// (inside callCommand: Api.CreateInlineLvlSdt()/CreateBlockLvlSdt(), then
	// SetTag(cc.tag), SetAlias(cc.alias), SetAppearance("hidden") if present).
	// null when marking is off for this action.
	function cc(m) {
		if (!isWord() || !shouldMark(m))
			return null;
		return { tag: TAG, alias: alias(m) };
	}

	// Author name for AI-written comments and replies. Used regardless of
	// the switch: it only says who wrote the comment.
	function commentAuthor(m) {
		let model = m && (m.model || m.provider) ? String(m.model || m.provider) : "";
		return model ? "AI Assistant (" + model + ")" : "AI Assistant";
	}

	function altText(m) {
		if (!shouldMark(m))
			return null;
		return "AI-generated image (" + shortModel(m) + ")";
	}

	function htmlToText(html) {
		if (!html)
			return "";
		try {
			let div = root.document.createElement("div");
			div.innerHTML = html;
			// Block elements become line breaks so paragraphs can be matched.
			div.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,tr,br,pre,blockquote").forEach(function(el) {
				el.insertAdjacentText("afterend", "\n");
			});
			return div.textContent || "";
		} catch (e) {
			return String(html).replace(/<[^>]*>/g, "");
		}
	}

	// Where the next insertion will land: the selected paragraphs, or the
	// paragraph with the cursor. Call it right before inserting.
	// Returns null when marking is off or not possible (then markInsertion
	// does nothing). Needs ApiParagraph.GetInternalId (9.2+) and
	// ApiDocumentContent.GetCurrentParagraph (9.0+).
	async function captureAnchor(m) {
		if (!isWord() || !shouldMark(m) || (m && NO_TEXT_MARK_ACTIONS[m.action]))
			return null;
		try {
			let anchor = await root.Asc.Editor.callCommand(function() {
				let doc = Api.GetDocument();
				if (typeof doc.GetAllParagraphs !== "function")
					return null;
				let first = null;
				let last = null;
				let selText = "";
				let sel = doc.GetRangeBySelect();
				if (sel && typeof sel.GetText === "function")
					selText = sel.GetText() || "";
				if (sel && selText !== "" && typeof sel.GetAllParagraphs === "function") {
					let sp = sel.GetAllParagraphs();
					if (sp.length) {
						first = sp[0];
						last = sp[sp.length - 1];
					}
				}
				if (!first && typeof doc.GetCurrentParagraph === "function")
					first = last = doc.GetCurrentParagraph();
				if (!first || !last || typeof first.GetInternalId !== "function")
					return null;
				let idFirst = first.GetInternalId();
				let idLast = last.GetInternalId();
				let paras = doc.GetAllParagraphs();
				let iFirst = -1;
				let iLast = -1;
				for (let i = 0; i < paras.length; i++) {
					let id = paras[i].GetInternalId();
					if (id === idFirst)
						iFirst = i;
					if (id === idLast)
						iLast = i;
				}
				if (iFirst < 0 || iLast < iFirst)
					return null;
				let norm = function(s) { return String(s || "").replace(/[\r\n]+$/, ""); };
				let firstText = norm(first.GetText());
				return {
					total: paras.length,
					first: iFirst,
					last: iLast,
					firstText: firstText,
					hadSelection: selText !== "",
					selectedWhole: selText !== "" && iFirst === iLast && norm(selText).trim() === firstText.trim()
				};
			});
			if (anchor)
				anchor.meta = m;
			return anchor;
		} catch (e) {
			console.error("[AIProvenance] captureAnchor failed:", e);
			return null;
		}
	}

	// Wraps the text inserted since captureAnchor() in inline content
	// controls (one per affected paragraph, so top-level element indexes used
	// by readDocument/editParagraph stay the same).
	// opts: { text } (plain text that was inserted) or { html }.
	// Returns { marked, skipped, reason? }.
	async function markInsertion(anchor, opts) {
		if (!anchor || !isWord())
			return { marked: 0, skipped: 0, reason: "no-anchor" };
		opts = opts || {};
		let needle = typeof opts.text === "string" ? opts.text : htmlToText(opts.html);
		let lines = String(needle || "").split(/\r?\n|\r/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

		let m = anchor.meta || {};
		let pr = { "Tag": TAG, "Alias": alias(m), "Appearance": 2 /* Asc.c_oAscSdtAppearance.Hidden */ };

		try {
			root.Asc.scope.aiProvenancePlan = {
				anchor: { total: anchor.total, first: anchor.first, last: anchor.last, firstText: anchor.firstText, hadSelection: anchor.hadSelection, selectedWhole: anchor.selectedWhole },
				needle: lines.join("\n"),
				lines: lines
			};
			let plan = await root.Asc.Editor.callCommand(function() {
				let p = Asc.scope.aiProvenancePlan;
				let a = p.anchor;
				let doc = Api.GetDocument();
				let paras = doc.GetAllParagraphs();
				let norm = function(s) { return String(s || "").replace(/[\r\n]+$/, ""); };
				let start = a.first;
				let end = a.last + (paras.length - a.total);
				if (start < 0 || end < start || end >= paras.length)
					return { error: "range" };
				let targets = [];
				if (start === end) {
					let t = norm(paras[start].GetText()).trim();
					if (!t)
						return { targets: targets };
					if (p.needle && t === p.needle.trim())
						targets.push({ i: start, whole: true });
					else if (!a.firstText.trim() || a.selectedWhole)
						targets.push({ i: start, whole: true });
					else if (p.lines.length === 1)
						targets.push({ i: start, find: p.lines[0] });
					else
						return { error: "ambiguous" };
					return { targets: targets };
				}
				// A cursor insertion that starts with a line break leaves the
				// paragraph with the cursor unchanged: skip it.
				let keptFirst = true;
				if (!a.hadSelection && norm(paras[start].GetText()) === a.firstText) {
					start++;
					keptFirst = false;
				}
				for (let k = start; k <= end; k++) {
					let t = norm(paras[k].GetText()).trim();
					if (!t)
						continue;
					let line = null;
					// The first/last paragraph may keep text that was there
					// before: mark only the inserted line when it can be found.
					if (k === start && keptFirst && a.firstText.trim() && !a.selectedWhole && p.lines.length)
						line = p.lines[0];
					else if (k === end && k !== start && p.lines.length)
						line = p.lines[p.lines.length - 1];
					if (line && t !== line && t.indexOf(line) !== -1)
						targets.push({ i: k, find: line });
					else
						targets.push({ i: k, whole: true });
				}
				return { targets: targets };
			});

			if (!plan || plan.error)
				return { marked: 0, skipped: 0, reason: plan ? plan.error : "plan" };

			let ids = [];
			let skipped = 0;
			for (let n = 0; n < plan.targets.length; n++) {
				root.Asc.scope.aiProvenanceTarget = plan.targets[n];
				let selected = await root.Asc.Editor.callCommand(function() {
					let t = Asc.scope.aiProvenanceTarget;
					let doc = Api.GetDocument();
					let par = doc.GetAllParagraphs()[t.i];
					if (!par)
						return false;
					let range = null;
					if (t.whole) {
						range = par.GetRange();
					} else if (typeof par.Search === "function") {
						let hits = par.Search(t.find, true);
						if (hits && hits.length === 1)
							range = hits[0];
					}
					if (!range)
						return false;
					range.Select();
					return true;
				});
				if (!selected) {
					skipped++;
					continue;
				}
				let res = await root.Asc.Editor.callMethod("AddContentControl", [2, pr]);
				if (res && res.InternalId)
					ids.push(res.InternalId);
				else
					skipped++;
			}

			// Make sure the marks are hidden and labelled even where the plugin
			// method ignores Appearance/Alias, then put the cursor after the
			// last one so the user's own typing is not marked.
			root.Asc.scope.aiProvenanceDone = { ids: ids, tag: TAG, alias: pr.Alias };
			await root.Asc.Editor.callCommand(function() {
				let d = Asc.scope.aiProvenanceDone;
				let doc = Api.GetDocument();
				doc.RemoveSelection();
				if (!d.ids.length)
					return;
				let list = typeof doc.GetContentControlsByTag === "function" ? doc.GetContentControlsByTag(d.tag) : doc.GetAllContentControls();
				let last = null;
				for (let i = 0; i < list.length; i++) {
					let sdt = list[i];
					if (typeof sdt.GetInternalId !== "function" || d.ids.indexOf(sdt.GetInternalId()) === -1)
						continue;
					if (typeof sdt.GetTag === "function" && sdt.GetTag() !== d.tag)
						sdt.SetTag(d.tag);
					if (typeof sdt.GetAlias === "function" && sdt.GetAlias() !== d.alias)
						sdt.SetAlias(d.alias);
					if (typeof sdt.SetAppearance === "function")
						sdt.SetAppearance("hidden");
					if (sdt.GetInternalId() === d.ids[d.ids.length - 1])
						last = sdt;
				}
				if (last && typeof last.MoveCursorOutside === "function")
					last.MoveCursorOutside(true);
			});

			return { marked: ids.length, skipped: skipped };
		} catch (e) {
			console.error("[AIProvenance] markInsertion failed:", e);
			return { marked: 0, skipped: 0, reason: "error" };
		}
	}

	// ── 3. Images: XMP with IPTC DigitalSourceType ─────────────────────────

	function xmlEscape(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function buildXmp(m) {
		let date = new Date().toISOString();
		let description = "AI-generated image (tool: " + TOOL_NAME + ", model: " + (modelLabel(m) || "unknown") + ", date: " + date.slice(0, 10) + ")";
		return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
			'<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
			' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
			'  <rdf:Description rdf:about=""\n' +
			'    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"\n' +
			'    xmlns:dc="http://purl.org/dc/elements/1.1/"\n' +
			'    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n' +
			'    Iptc4xmpExt:DigitalSourceType="' + DIGITAL_SOURCE_TYPE + '"\n' +
			'    xmp:CreatorTool="' + xmlEscape(TOOL_NAME) + '"\n' +
			'    xmp:CreateDate="' + date + '">\n' +
			'   <dc:description>\n' +
			'    <rdf:Alt>\n' +
			'     <rdf:li xml:lang="x-default">' + xmlEscape(description) + '</rdf:li>\n' +
			'    </rdf:Alt>\n' +
			'   </dc:description>\n' +
			'  </rdf:Description>\n' +
			' </rdf:RDF>\n' +
			'</x:xmpmeta>\n' +
			'<?xpacket end="w"?>';
	}

	function utf8(s) {
		return new TextEncoder().encode(s);
	}

	function ascii(s) {
		let out = new Uint8Array(s.length);
		for (let i = 0; i < s.length; i++)
			out[i] = s.charCodeAt(i) & 0xFF;
		return out;
	}

	function concat(parts) {
		let len = 0;
		parts.forEach(function(p) { len += p.length; });
		let out = new Uint8Array(len);
		let pos = 0;
		parts.forEach(function(p) { out.set(p, pos); pos += p.length; });
		return out;
	}

	function base64ToBytes(b64) {
		let bin = root.atob(b64);
		let out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++)
			out[i] = bin.charCodeAt(i);
		return out;
	}

	function bytesToBase64(bytes) {
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000)
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return root.btoa(bin);
	}

	function indexOfBytes(hay, needle, from, to) {
		let end = Math.min(to === undefined ? hay.length : to, hay.length) - needle.length;
		outer: for (let i = from || 0; i <= end; i++) {
			for (let j = 0; j < needle.length; j++) {
				if (hay[i + j] !== needle[j])
					continue outer;
			}
			return i;
		}
		return -1;
	}

	let crcTable = null;
	function crc32(bytes) {
		if (!crcTable) {
			crcTable = new Uint32Array(256);
			for (let n = 0; n < 256; n++) {
				let c = n;
				for (let k = 0; k < 8; k++)
					c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
				crcTable[n] = c >>> 0;
			}
		}
		let crc = 0xFFFFFFFF;
		for (let i = 0; i < bytes.length; i++)
			crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
		return (crc ^ 0xFFFFFFFF) >>> 0;
	}

	function u32(n) {
		return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
	}

	const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	const XMP_KEYWORD = "XML:com.adobe.xmp";
	const JPEG_XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

	function isPng(b) {
		return b.length > 33 && PNG_SIGNATURE.every(function(v, i) { return b[i] === v; });
	}

	function isJpeg(b) {
		return b.length > 4 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
	}

	// Inserts an iTXt chunk (keyword XML:com.adobe.xmp, uncompressed) right
	// after IHDR. All other chunks are copied byte for byte.
	function markPng(b, xmp) {
		let pos = 8;
		let ihdrEnd = -1;
		while (pos + 12 <= b.length) {
			let len = ((b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]) >>> 0;
			let type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
			let dataStart = pos + 8;
			if (dataStart + len + 4 > b.length)
				return { status: "invalid" };
			if (type === "IHDR")
				ihdrEnd = dataStart + len + 4;
			// C2PA manifest store: its hash covers the file, any new chunk
			// would invalidate it. The manifest already carries provenance.
			if (type === "caBX")
				return { status: "skipped-c2pa" };
			if ((type === "iTXt" || type === "tEXt" || type === "zTXt") && indexOfBytes(b, ascii(XMP_KEYWORD + "\0"), dataStart, dataStart + XMP_KEYWORD.length + 1) === dataStart)
				return { status: "skipped-existing-xmp" };
			if (type === "IEND")
				break;
			pos = dataStart + len + 4;
		}
		if (ihdrEnd < 0)
			return { status: "invalid" };

		let data = concat([
			ascii(XMP_KEYWORD), new Uint8Array([0, 0, 0, 0, 0]), // keyword\0, compression flag 0, method 0, language "", translated keyword ""
			utf8(xmp)
		]);
		let typeAndData = concat([ascii("iTXt"), data]);
		let chunk = concat([u32(data.length), typeAndData, u32(crc32(typeAndData))]);
		return { status: "marked", bytes: concat([b.subarray(0, ihdrEnd), chunk, b.subarray(ihdrEnd)]) };
	}

	// Inserts an APP1 XMP segment after the leading APP0 (JFIF) / APP1 (Exif)
	// segments. All other segments are copied byte for byte.
	function markJpeg(b, xmp) {
		let pos = 2;
		let insertAt = 2;
		let leading = true;
		while (pos + 4 <= b.length && b[pos] === 0xFF) {
			let marker = b[pos + 1];
			if (marker === 0xFF) {             // fill byte
				pos++;
				continue;
			}
			if (marker === 0xDA || marker === 0xD9)   // start of scan / end of image
				break;
			let len = (b[pos + 2] << 8) | b[pos + 3];
			if (len < 2 || pos + 2 + len > b.length)
				return { status: "invalid" };
			let segStart = pos + 4;
			if (marker === 0xE1 && indexOfBytes(b, ascii(JPEG_XMP_HEADER), segStart, segStart + JPEG_XMP_HEADER.length) === segStart)
				return { status: "skipped-existing-xmp" };
			// C2PA (JUMBF in APP11): a new segment would break its hash.
			if (marker === 0xEB && indexOfBytes(b, ascii("c2pa"), segStart, pos + 2 + len) !== -1)
				return { status: "skipped-c2pa" };
			if (leading && (marker === 0xE0 || (marker === 0xE1 && indexOfBytes(b, ascii("Exif\0"), segStart, segStart + 5) === segStart)))
				insertAt = pos + 2 + len;
			else
				leading = false;
			pos += 2 + len;
		}

		let payload = concat([ascii(JPEG_XMP_HEADER), utf8(xmp)]);
		let segLen = payload.length + 2;
		if (segLen > 0xFFFF)
			return { status: "invalid" };
		let segment = concat([new Uint8Array([0xFF, 0xE1, (segLen >> 8) & 0xFF, segLen & 0xFF]), payload]);
		return { status: "marked", bytes: concat([b.subarray(0, insertAt), segment, b.subarray(insertAt)]) };
	}

	// Accepts a data URL or bare base64. Returns { data, status }; data has
	// the same form as the input (unchanged unless status is "marked").
	function markImageDetailed(input, m) {
		if (typeof input !== "string" || !input)
			return { data: input, status: "unsupported" };
		if (!shouldMark(m || {}))
			return { data: input, status: "disabled" };
		let prefix = "";
		let b64 = input;
		let match = /^data:([^;,]*)(;[^,]*)?,/.exec(input);
		if (match) {
			if (!/;base64/i.test(match[2] || ""))
				return { data: input, status: "unsupported" };
			prefix = match[0];
			b64 = input.slice(prefix.length);
		} else if (!/^[A-Za-z0-9+/=\s]+$/.test(input.slice(0, 64))) {
			return { data: input, status: "unsupported" };   // URL or other
		}
		try {
			let bytes = base64ToBytes(b64.replace(/\s+/g, ""));
			let xmp = buildXmp(m || {});
			let res;
			if (isPng(bytes))
				res = markPng(bytes, xmp);
			else if (isJpeg(bytes))
				res = markJpeg(bytes, xmp);
			else
				return { data: input, status: "unsupported" };
			if (res.status !== "marked")
				return { data: input, status: res.status };
			return { data: prefix + bytesToBase64(res.bytes), status: "marked" };
		} catch (e) {
			console.error("[AIProvenance] markImage failed:", e);
			return { data: input, status: "error" };
		}
	}

	function markImage(input, m) {
		return markImageDetailed(input, m).data;
	}

	root.AIProvenance = {
		TAG: TAG,
		POLICY: POLICY,
		PROPS: PROPS,
		EXEMPT_ACTIONS: EXEMPT_ACTIONS,
		STORAGE_KEY: STORAGE_KEY,

		isEnabled: isEnabled,
		isLocked: isLocked,
		setUserEnabled: setUserEnabled,
		isExempt: isExempt,

		meta: meta,
		modelLabel: modelLabel,
		mergeModels: mergeModels,

		beginScope: beginScope,
		endScope: endScope,
		noteRequest: noteRequest,
		scopeMeta: scopeMeta,
		runTool: runTool,

		record: record,

		cc: cc,
		altText: altText,
		commentAuthor: commentAuthor,
		captureAnchor: captureAnchor,
		markInsertion: markInsertion,

		markImage: markImage,
		markImageDetailed: markImageDetailed,
		_crc32: crc32
	};

})(typeof window !== "undefined" ? window : globalThis);
