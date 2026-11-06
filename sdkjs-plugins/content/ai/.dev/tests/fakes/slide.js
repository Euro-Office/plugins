// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Small in-memory model of the ONLYOFFICE Presentation Builder API covering
// the methods the AI tools use (sdkjs slide/apiBuilder.js):
//  - ApiPresentation.GetSlideByIndex(i) is 0-based and returns null when missing
//  - ApiSlide.GetSlideIndex() is 0-based; MoveTo(i) returns a boolean
//  - ApiShape.GetDocContent() -> ApiDocumentContent of paragraphs; images have none
//  - ApiDocumentContent.RemoveAllElements() leaves one empty paragraph
//  - ApiNotesPage.GetBodyShapeText() joins the note paragraphs with "\r\n"

import { createCustomProperties } from "./props.js";

class Paragraph {
	constructor(text = "") { this.text = text; }
	GetClassType() { return "paragraph"; }
	GetText() { return this.text; }
	AddText(t) { this.text += t; return { GetClassType: () => "run" }; }
}

class DocContent {
	constructor(lines) { this.paragraphs = lines.map((t) => new Paragraph(t)); }
	GetClassType() { return "documentContent"; }
	GetElementsCount() { return this.paragraphs.length; }
	GetElement(i) { return this.paragraphs[i] || null; }
	RemoveAllElements() { this.paragraphs = [new Paragraph("")]; }
	Push(p) { this.paragraphs.push(p); return true; }
	text() { return this.paragraphs.map((p) => p.text).join("\r\n"); }
}

class Drawing {
	constructor({ type = "shape", text, placeholder }) {
		this.type = type;
		this.content = typeof text === "string" ? new DocContent(text.split("\n")) : null;
		this.placeholder = placeholder || null;
	}
	GetClassType() { return this.type; }
	GetDocContent() { return this.content; }
	GetPlaceholder() { return this.placeholder ? { GetType: () => this.placeholder } : null; }
}

class NotesPage {
	constructor(text) { this.body = new Drawing({ type: "shape", text: text || "", placeholder: "body" }); }
	GetBodyShape() { return this.body; }
	GetBodyShapeText() { return this.body.content.text(); }
}

class Slide {
	constructor(pres, { shapes = [], notes = "" }) {
		this.pres = pres;
		this.drawings = shapes.map((s) => new Drawing(typeof s === "string" ? { text: s } : s));
		this.notes = new NotesPage(notes);
	}
	GetClassType() { return "slide"; }
	GetSlideIndex() { return this.pres.slides.indexOf(this); }
	GetAllDrawings() { return this.drawings.slice(); }
	GetAllShapes() { return this.drawings.filter((d) => d.type === "shape"); }
	GetNotesPage() { return this.notes; }
	MoveTo(i) {
		const s = this.pres.slides;
		if (i < 0 || i >= s.length) return false;
		s.splice(s.indexOf(this), 1);
		s.splice(i, 0, this);
		return true;
	}
}

class Presentation {
	constructor() { this.slides = []; this.current = 0; this.props = createCustomProperties(); this.customProperties = this.props.store; }
	GetCustomProperties() { return this.props.api; }
	GetClassType() { return "presentation"; }
	GetSlidesCount() { return this.slides.length; }
	GetSlideByIndex(i) { return this.slides[i] || null; }
	GetCurrentSlide() { return this.slides[this.current] || null; }
}

/**
 * @param {object} spec
 * @param {Array<{ shapes: Array<string|{type, text, placeholder}>, notes?: string }>} spec.slides
 * @param {number} [spec.current]   1-based current slide
 * @param {string} [spec.selectedText]
 */
export function createPresentation(spec = {}) {
	const pres = new Presentation();
	for (const s of spec.slides || []) pres.slides.push(new Slide(pres, s));
	pres.current = (spec.current || 1) - 1;
	const state = { selectedText: spec.selectedText || "", pasted: [] };

	const Api = {
		GetPresentation: () => pres,
		CreateParagraph: () => new Paragraph("")
	};
	const methods = {
		GetSelectedText: () => state.selectedText,
		GetSelectedContent: () => state.selectedText,
		PasteText: (text) => { state.pasted.push(text); state.selectedText = ""; return true; },
		GoToSlide: (n) => { pres.current = n - 1; return true; }
	};
	return { Api, pres, methods, state };
}
