# Original focused locale preflight — ZERO EXECUTION

Exact original whole-file proposal for coordinating Root only, HOLD/UNRUN:

```sh
cd /workspace/session-2295-blog/src/frontend
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/session-2295-ui pnpm exec vitest run --config vitest.config.ts ../../tests/frontend/unit/locales/localeDomainBundleStore.test.ts
```

Original literal case: `loads and validates every locale/domain pair independently`.
This test imports actual LocaleDomainBundleStore/locale loaders/catalog, route-domain
map and appRouteRecords. Its callbacks dynamically import every canonical zh-CN domain
and all100 enabled locale/domain artifacts, invoke original schema calculation and
actual store admission. Original Vitest config also evaluates local alias/plugins/
worker options and runs HappyDOM storage/window/rAF/native mocks plus locale runtime
setup. None of these imports, setup hooks, list/collection or cases was executed.

No new runner/config/filter/-t, alternate entry, candidate generator, reduced TS
program, focused-only substitution for all-domain identity or synthetic successful
locale/native/refset fixture. Static AST proof is not original focused-check PASS.
Original separator test is excluded from production offer and remains UNRUN; any
future original test packet and full-file CLI need separate Root exposure review.
