// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: Apache-2.0
'use strict';

const REPO = 'https://github.com/Euro-Office/plugins';
const DOCS = 'https://euro-office.github.io/documentation/configuration/plugins/';
const EDITORS = { word: 'Documents', cell: 'Spreadsheets', slide: 'Presentations', pdf: 'PDF' };
// "recommended" is the upstream store's curation, not ours, so it is not shown
const CATEGORIES = {
	work: 'Work',
	devTools: 'Developer tools',
	communication: 'Communication',
	entertainment: 'Entertainment',
	specAbilities: 'Special abilities',
};

const dark = matchMedia('(prefers-color-scheme: dark)');
let plugins = [];

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value !== undefined && value !== null) node.setAttribute(key, value);
	}
	node.append(...children.flat().filter((c) => c !== null && c !== undefined));
	return node;
}

async function getJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(url + ': ' + response.status);
	return response.json();
}

async function getBundled() {
	try {
		const response = await fetch('bundle.txt');
		if (!response.ok) return new Set();
		const lines = (await response.text()).split('\n').map((l) => l.trim());
		return new Set(lines.filter((l) => l && !l.startsWith('#')));
	} catch {
		return new Set();
	}
}

// Mirrors store/scripts/code.js getImageUrl: store.icons first, then the old icons array
function iconCandidates(base, variation) {
	const theme = dark.matches ? 'dark' : 'light';
	const list = [];
	const store = variation.store || {};
	if (store.icons) list.push(base + store.icons[theme] + '/icon.png');
	const icons = variation.icons;
	if (Array.isArray(icons)) {
		for (const icon of icons) {
			if (typeof icon === 'string') list.push(base + icon);
			else if (icon && icon['100%']) list.push(base + icon['100%'].normal);
		}
	}
	return list;
}

async function loadPlugin(entry, info, bundled) {
	const base = 'sdkjs-plugins/content/' + entry.name + '/';
	try {
		const config = await getJson(base + 'config.json');
		const variation = (config.variations && config.variations[0]) || {};
		const store = variation.store || {};
		const background = store.background && store.background[dark.matches ? 'dark' : 'light'];
		return {
			id: entry.name,
			name: config.name || entry.name,
			description: variation.description || config.description || '',
			version: config.version,
			editors: Object.keys(EDITORS).filter((e) => (variation.EditorsSupport || []).includes(e)),
			categories: (store.categories || []).filter((c) => CATEGORIES[c]),
			icons: iconCandidates(base, variation),
			background: background ? background.replace(/;+$/, '') : '',
			screenshots: (store.screenshots || []).map((s) => base + s),
			services: info ? info.services : null,
			license: info ? info.license : null,
			bundled: bundled.has(entry.name),
		};
	} catch (error) {
		console.warn(error);
		return null;
	}
}

function iconNode(plugin, large) {
	const box = el('span', { class: large ? 'icon large' : 'icon', 'aria-hidden': 'true' });
	if (plugin.background) box.style.background = plugin.background;
	const queue = plugin.icons.slice();
	const next = () => {
		const src = queue.shift();
		if (!src) {
			box.replaceChildren(plugin.name.charAt(0).toUpperCase());
			return;
		}
		const img = el('img', { src, alt: '', loading: 'lazy' });
		img.onerror = next;
		box.replaceChildren(img);
	};
	next();
	return box;
}

function badges(plugin) {
	return el('ul', { class: 'badges' },
		plugin.bundled ? el('li', { class: 'bundled' }, 'Bundled') : null,
		plugin.editors.map((e) => el('li', {}, EDITORS[e])));
}

function card(plugin) {
	return el('li', {}, el('a', { class: 'card', href: '#' + plugin.id },
		iconNode(plugin, false),
		el('div', {}, el('h2', {}, plugin.name), el('p', {}, plugin.description), badges(plugin))));
}

function renderGrid() {
	const query = document.getElementById('search').value.trim().toLowerCase();
	const category = document.getElementById('category').value;
	const shown = plugins.filter((p) =>
		(!category || p.categories.includes(category)) &&
		(!query || (p.name + ' ' + p.id + ' ' + p.description).toLowerCase().includes(query)));
	document.getElementById('grid').replaceChildren(...shown.map(card));
	document.getElementById('count').textContent =
		shown.length === 1 ? '1 plugin' : shown.length + ' plugins';
}

function servicesNode(services) {
	if (services === null) return 'Not reviewed';
	if (!services.length) return 'None';
	return el('ul', { class: 'services' }, services.map((s) => el('li', {}, s)));
}

function copyButton(text) {
	const button = el('button', { type: 'button' }, 'Copy');
	button.onclick = async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = 'Copied';
		} catch {
			button.textContent = 'Copy failed';
		}
		setTimeout(() => { button.textContent = 'Copy'; }, 2000);
	};
	return button;
}

function installNode(plugin) {
	if (plugin.bundled) return [el('p', {}, 'Included in the server image.')];
	const command = 'documentserver-pluginsmanager.sh --install="' + plugin.id + '"';
	return [
		el('p', {}, 'Install with the plugin manager on the server:'),
		el('div', { class: 'command' }, el('code', {}, command), copyButton(command)),
		el('p', {}, 'Or download ',
			el('a', { href: REPO + '/releases/latest/download/' + plugin.id + '.plugin' }, plugin.id + '.plugin'),
			'. See the ', el('a', { href: DOCS }, 'administrator documentation'), ' for details.'),
	];
}

function renderDetail(plugin) {
	const detail = document.getElementById('detail');
	const heading = el('h2', { tabindex: '-1' }, plugin.name);
	detail.replaceChildren(
		el('p', {}, el('a', { href: '#' }, 'All plugins')),
		el('div', { class: 'head' }, iconNode(plugin, true), el('div', {}, heading, badges(plugin))),
		el('p', {}, plugin.description),
		el('dl', {},
			el('dt', {}, 'Version'), el('dd', {}, plugin.version || 'Unknown'),
			el('dt', {}, 'Editors'), el('dd', {}, plugin.editors.map((e) => EDITORS[e]).join(', ') || 'Unknown'),
			el('dt', {}, 'Categories'), el('dd', {}, plugin.categories.map((c) => CATEGORIES[c]).join(', ') || 'None'),
			el('dt', {}, 'External services'), el('dd', {}, servicesNode(plugin.services)),
			el('dt', {}, 'Licence'), el('dd', {}, plugin.license || 'Not reviewed'),
			el('dt', {}, 'Source'), el('dd', {},
				el('a', { href: REPO + '/tree/main/sdkjs-plugins/content/' + plugin.id }, 'sdkjs-plugins/content/' + plugin.id))),
		el('h3', {}, 'Install'),
		...installNode(plugin),
		plugin.screenshots.length ? el('h3', {}, 'Screenshots') : null,
		plugin.screenshots.length ? el('div', { class: 'shots', tabindex: '0', 'aria-label': 'Screenshots' },
			plugin.screenshots.map((src, i) => el('img', {
				src, loading: 'lazy', alt: plugin.name + ' screenshot ' + (i + 1) + ' of ' + plugin.screenshots.length,
			}))) : null);
	return heading;
}

let lastHash = '';
function route() {
	const id = decodeURIComponent(location.hash.slice(1));
	const plugin = plugins.find((p) => p.id === id);
	const list = document.getElementById('list');
	const detail = document.getElementById('detail');
	list.hidden = !!plugin;
	detail.hidden = !plugin;
	document.title = plugin ? plugin.name + ' - Editor plugins' : 'Editor plugins';
	if (plugin) {
		renderDetail(plugin).focus();
	} else if (lastHash) {
		const back = document.querySelector('.card[href="#' + CSS.escape(lastHash) + '"]');
		if (back) back.focus();
	}
	lastHash = plugin ? id : '';
}

async function main() {
	const select = document.getElementById('category');
	for (const [value, label] of Object.entries(CATEGORIES)) select.append(el('option', { value }, label));
	try {
		const [store, info, bundled] = await Promise.all([
			getJson('store/config.json'), getJson('catalogue.json'), getBundled()]);
		const loaded = await Promise.all(store.map((entry) => loadPlugin(entry, info[entry.name], bundled)));
		plugins = loaded.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		document.getElementById('count').textContent = 'Could not load the plugin list.';
		console.error(error);
		return;
	}
	document.getElementById('search').addEventListener('input', renderGrid);
	select.addEventListener('change', renderGrid);
	window.addEventListener('hashchange', route);
	renderGrid();
	route();
}

main();
