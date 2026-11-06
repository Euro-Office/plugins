#!/usr/bin/env python3
# SPDX-FileCopyrightText: Euro-Office contributors
# SPDX-License-Identifier: Apache-2.0
"""Fail if catalogue.json does not match store/config.json or the catalogue page loads external resources."""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
errors = []

store = {p['name'] for p in json.loads((root / 'store/config.json').read_text(encoding='utf-8-sig'))}
catalogue = json.loads((root / 'catalogue.json').read_text(encoding='utf-8'))
for name in sorted(store - catalogue.keys()):
    errors.append(f'catalogue.json: missing {name}')
for name in sorted(catalogue.keys() - store):
    errors.append(f'catalogue.json: {name} is not in store/config.json')
for name, entry in catalogue.items():
    services = entry.get('services', 'missing')
    if not (services is None or (isinstance(services, list) and all(isinstance(s, str) for s in services))):
        errors.append(f'catalogue.json: {name}.services must be a list of strings or null')
    if not (entry.get('license', 'missing') is None or isinstance(entry.get('license'), str)):
        errors.append(f'catalogue.json: {name}.license must be a string or null')

# ponytail: regex scan, a resource URL built from concatenated strings slips through
external = r'["\'`]?\s*(?:https?:)?//'
patterns = {
    'index.html': rf'<(?:script|link|img|source|iframe|video|audio|embed|object)\b[^>]*\b(?:src|href|srcset|data)\s*=\s*{external}',
    'catalogue.css': rf'url\(\s*{external}|@import\s+(?:url\()?{external}',
    'catalogue.js': rf'\b(?:src|srcset)\s*[:=]\s*{external}|\b(?:fetch|import|open)\s*\([^)]*?{external}|<(?:script|link|img)\b',
}
for name, pattern in patterns.items():
    for number, line in enumerate((root / name).read_text(encoding='utf-8').splitlines(), 1):
        if re.search(pattern, line, re.IGNORECASE):
            errors.append(f'{name}:{number}: external resource: {line.strip()}')

print('\n'.join(errors) or f'ok: {len(catalogue)} plugins, no external resources')
sys.exit(1 if errors else 0)
