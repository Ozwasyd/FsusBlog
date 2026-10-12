# Original allowed static source tooling

Actual current Main invocations, original local UI alias retained for frontend tools:

```sh
node tools/frontend/sync-locale-domain-schema.mjs --check --domain admin
node tools/frontend/sync-locale-domain-schema.mjs --write --domain admin
node tools/frontend/sync-locale-domain-schema.mjs --check --domain admin
node tools/frontend/check-locale-domain-static.mjs
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/session-2295-ui node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/session-2295-ui node /workspace/FsusUI/node_modules/eslint/bin/eslint.js tools/frontend/sync-locale-domain-schema.mjs tools/frontend/check-locale-domain-schema-source-controls.mjs --max-warnings 0
```

Whole original application remains RED, original static producer write changed:false;
no product modules are imported by producer. AST13 and original strict-full11 exact
paths are enumerated in source-proof.json. Normal original frontend style CLI uses
--mode strict-full and one --file per those11frontend paths; no reduced program.

Original focused runtime preflight ONLY, HOLD/UNRUN; not executed/listed/collected:

```sh
cd /workspace/session-2295-blog/src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/session-2295-ui pnpm exec vitest run --config vitest.config.ts ../../tests/frontend/unit/locales/localeDomainBundleStore.test.ts
```

Original case `loads and validates every locale/domain pair independently` dynamically
imports all canonical/100 artifacts and actual bundle-store admission. Existing config
loads plugins/alias/workers/setup; HappyDOM storage/window/rAF/native replacements
and actual locale runtime execute beforeAll. None executed here. Current static gate
is not runtime/focused/source-snapshot/receipt/UX qualification. No entry/config/test
or frozen expectation changed, and no new shortcut around holds exists.
