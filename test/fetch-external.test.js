// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: Apache-2.0
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'fetch-external.sh');
const root = path.join(__dirname, '..');

// Fake gh: "downloads" a .plugin built from $FAKE_PLUGIN_DIR, logging its arguments
function fakeGh(dir, pluginDir) {
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$@" >> "${dir}/gh.log"
while [ $# -gt 0 ]; do
	case $1 in --pattern) pattern=$2; shift ;; --dir) out=$2; shift ;; esac
	shift
done
cd "${pluginDir}" && zip -qr "$out/$pattern" .
`, { mode: 0o755 });
	return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

function run(manifest, env) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-external-'));
	const file = path.join(dir, 'external.json');
	fs.writeFileSync(file, JSON.stringify(manifest));
	return spawnSync('sh', [script, file], { env, encoding: 'utf8' });
}

test('empty manifest does nothing', () => {
	const result = run([], process.env);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, '');
});

test('downloads the release asset and unpacks it into content/<name>', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-external-'));
	const plugin = path.join(dir, 'plugin');
	fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(plugin, 'config.json'), '{"name":"Test"}');
	fs.writeFileSync(path.join(plugin, 'scripts', 'code.js'), '// code');
	const dest = path.join(root, 'sdkjs-plugins', 'content', 'zz-fetch-test');
	t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

	const result = run([{ name: 'zz-fetch-test', repo: 'Euro-Office/plugin-zz', tag: 'v1.2.3' }], fakeGh(dir, plugin));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(path.join(dest, 'config.json'), 'utf8'), '{"name":"Test"}');
	assert.ok(fs.existsSync(path.join(dest, 'scripts', 'code.js')));
	assert.match(fs.readFileSync(path.join(dir, 'gh.log'), 'utf8'), /release download v1\.2\.3 --repo Euro-Office\/plugin-zz --pattern zz-fetch-test\.plugin/);
});

test('refuses a plugin that is also kept in this repository', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-external-'));
	const result = run([{ name: 'wordscounter', repo: 'Euro-Office/plugin-wordscounter', tag: 'v1' }], fakeGh(dir, dir));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /wordscounter is also kept in this repository/);
});

test('rejects an asset without config.json at its root', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-external-'));
	const plugin = path.join(dir, 'plugin');
	fs.mkdirSync(path.join(plugin, 'src'), { recursive: true });
	fs.writeFileSync(path.join(plugin, 'src', 'config.json'), '{}');
	t.after(() => fs.rmSync(path.join(root, 'sdkjs-plugins', 'content', 'zz-nested'), { recursive: true, force: true }));

	const result = run([{ name: 'zz-nested', repo: 'Euro-Office/plugin-zz', tag: 'v1' }], fakeGh(dir, plugin));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no config.json at its root/);
});
