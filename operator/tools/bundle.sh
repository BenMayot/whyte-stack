#!/bin/sh
# Packs this site's source into netlify/lib/src_bundle.mjs so the live site can hand it back at /api/src. Run before every deploy.
cd "$(dirname "$0")/.." || exit 1
B=$(tar czf - --exclude=node_modules --exclude=netlify/lib/src_bundle.mjs --exclude=.netlify netlify.toml package.json netlify public tools $( [ -f SOURCE.md ] && echo SOURCE.md ) | base64 -w0)
printf 'export const BUILT_AT = "%s";\nexport const BUNDLE = "%s";\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$B" > netlify/lib/src_bundle.mjs
echo "bundled $(echo -n "$B" | wc -c) base64 bytes"
