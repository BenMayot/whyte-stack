# whyte-ads-operator: read before changing or deploying

This folder is the full source of https://whyte-ads-operator.netlify.app (Netlify site 1107ad97-135c-4fc9-bef9-f69437a955b6).

1. Always start from the live source: `curl -H "x-op-pass: <operator password>" https://whyte-ads-operator.netlify.app/api/src -o src.tgz && tar xzf src.tgz`.
   Never rebuild the site from a project doc: the docs lag behind. On Nov 19, 2026 a rebuild from a Nov 17 doc rolled the live site back two days.
2. Make the change.
3. `sh tools/bundle.sh`, then deploy.
4. Check after deploying: `/api/plan`, `/api/queue`, `/api/act` (POST) and `/api/src?info=1` must not return 404, and the page must contain `class="tgl` and `This week’s plan`.

Tabs: Ads (calls, on/off switches with the action PIN), Creative (plan, patterns, ledger from Motion tags), Rules (rulebook, call log, learning).
