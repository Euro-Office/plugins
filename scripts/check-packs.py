#!/usr/bin/env python3
# SPDX-FileCopyrightText: Euro-Office contributors
# SPDX-License-Identifier: Apache-2.0
"""Fail if a .plugin lacks a root config.json or loads the v1 helpers from anywhere but sdkjs-plugins/v1/.

With a store config as second argument, also fail if a store plugin has no pack or no sdkjs-plugins/content/<name>/config.json.
"""
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path

helper_ref = re.compile(r'''(?:src|href)\s*=\s*["']([^"']*v1/plugins[^"']*)''')
packs = sorted(Path(sys.argv[1]).glob('*.plugin'))
bad = not packs
if bad:
    print(f'check-packs.py: no .plugin files in {sys.argv[1]}')

for pack in packs:
    with zipfile.ZipFile(pack) as archive:
        if 'config.json' not in archive.namelist():
            print(f'{pack.name}: no config.json at archive root')
            bad = True
        for name in archive.namelist():
            data = archive.read(name)
            if b'//onlyoffice.github.io/sdkjs-plugins/' in data:
                print(f'{pack.name}:{name}: onlyoffice.github.io helper URL')
                bad = True
            if not name.endswith('.html'):
                continue
            # installed as sdkjs-plugins/<name>/, so helpers must resolve to ../v1/ from the plugin root
            for url in helper_ref.findall(data.decode('utf-8', 'replace')):
                if not posixpath.normpath(posixpath.join(posixpath.dirname(name), url)).startswith('../v1/'):
                    print(f'{pack.name}:{name}: {url} does not resolve to sdkjs-plugins/v1/')
                    bad = True

if len(sys.argv) > 2:
    content = Path(__file__).resolve().parent.parent / 'sdkjs-plugins' / 'content'
    for entry in json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')):
        name = entry['name']
        if not (Path(sys.argv[1]) / f'{name}.plugin').is_file():
            print(f'{sys.argv[2]}: {name} has no {name}.plugin')
            bad = True
        if not (content / name / 'config.json').is_file():
            print(f'{sys.argv[2]}: {name} has no sdkjs-plugins/content/{name}/config.json')
            bad = True

sys.exit(1 if bad else 0)
