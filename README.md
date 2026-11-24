# whyte-stack

Source of the tools Rivage Marketing runs for the WHYTE account. Private. No keys or passwords live in this repo: they are Netlify environment variables.

## What is here

| Folder | Live site | Netlify site id | State in this repo |
|---|---|---|---|
| `operator/` | https://whyte-ads-operator.netlify.app | 1107ad97-135c-4fc9-bef9-f69437a955b6 | Complete. Pulled from the live site's `/api/src` (build of 2026-11-23 16:26 UTC) |
| `creator-brief/` | https://whyte-creator-brief.netlify.app | 5fec0fc3-d5bd-4f89-9116-7ab573d99504 | Pages only (`public/index.html`, `public/shub.html`, fetched live 2026-11-24). Function source not recovered yet |
| `spine/` (to come) | https://whyte-data-spine.netlify.app | 0f016d1c-b06e-4488-9ea3-cb70afc10833 | Not recovered. The live site has no source endpoint and the project docs are behind it |
| `creative-engine/` (to come) | https://whyte-creative-engine.netlify.app | see `WHYTE_creative_system.md` in the project | Not recovered |

## Rules

1. This repo is the only place a WHYTE site is changed from. Never rebuild a site from a project doc.
2. Nothing is deployed from here yet. Netlify is not connected to this repo: deploys are still done by hand.
3. Before any deploy of a folder, compare it with what is live. For the operator: pull `/api/src` and `diff -r` against `operator/`. If they differ, the live site wins until the difference is understood.

## Operator: deploy steps

1. Make the change in `operator/`.
2. `sh operator/tools/bundle.sh`. This writes `operator/netlify/lib/src_bundle.mjs`, which the site serves back at `/api/src`. The file is generated and is not committed.
3. Deploy `operator/` to the Netlify site above.
4. Check with the operator password: `/api/data`, `/api/report`, `/api/creative`, `/api/plan`, `/api/queue`, `/api/log` and `/api/src?info=1` return 200; a POST to `/api/act` does not return 404; the page contains `class="tgl`, `rp-loop` and `This week’s plan`.

Environment variables the operator reads: `OPERATOR_PASSWORD`, `OPERATOR_ACTION_PIN`, `SPINE_URL`, `SPINE_API_KEY`, `ENGINE_URL`, `ENGINE_KEY`, `PREVIEW_KEY`.

## Still to do

- Recover the spine, the creator-brief function and the creative engine into this repo, each checked against its live output before it is trusted.
- Give each of those sites a source endpoint like the operator's, so live and repo can always be compared.
- Connect Netlify to this repo so a push is the only way to deploy.
- Move every rule threshold into one versioned file shared by the spine and the operator.
