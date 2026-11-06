/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "goToSlide",
		"category": "core",
		"readOnly": true,
		"text": "Go to Slide",
		"description": "Shows the given slide in the editor (makes it the current slide). Use it to show the user a search result or before tools that act on the current slide. Slide numbers are 1-based. Does not change the presentation.",
		"parameters": {
			"type": "object",
			"properties": {
				"slideNumber": {
					"type": "number",
					"description": "1-based number of the slide to show."
				}
			},
			"required": ["slideNumber"]
		},
		"examples": [
			{
				"prompt": "Go to slide 7",
				"arguments": { "slideNumber": 7 }
			}
		]
	});

	func.call = async function(params) {
		if (typeof params.slideNumber !== 'number' || params.slideNumber < 1)
			throw new window.AgentState.ToolError('Parameter "slideNumber" must be a number >= 1. Got: ' + JSON.stringify(params.slideNumber));
		let n = Math.floor(params.slideNumber);
		let total = await Asc.Editor.callCommand(function(){
			return Api.GetPresentation().GetSlidesCount();
		});
		if (n > total)
			throw new window.AgentState.ToolError('Slide ' + n + ' does not exist. The presentation has ' + total + ' slides.');
		// Plugin method GoToSlide (1-based), available since 9.0.0
		await Asc.Editor.callMethod("GoToSlide", [n]);
		return { slideNumber: n, totalSlides: total };
	};

	func.describe = function(args) {
		return { start: toolText("Go to slide %1", args.slideNumber), done: toolText("Went to slide %1", args.slideNumber), phrase: toolText("went to a slide") };
	};

	return func;
})();
