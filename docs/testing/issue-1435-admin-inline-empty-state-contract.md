# Issue #1435：admin inline empty-state 测试职责

## 权威边界

`AdminInlineEmptyState.vue` 是 admin inline empty-state 的语义与 inset owner。所有 consumer 继承 `--fsus-admin-inline-empty-state-inset`，desktop/mobile 只在组件内将该 property 映射到 foundation spacing token。consumer 不得通过 inline style、`!important`、负 margin 或私有 padding 覆盖它；静态检查会扫描全部实际 consumer。

`tests/frontend/fixtures/admin-inline-empty-state-contract.json` 是 consumer representative 与视觉诊断 registry。article、category、user、queue、anonymous 各自只登记接线差异；共享组件行为不在每个 caller 重复验证。未经登记的 override exception 会 fail closed。

## 测试分层

- `AdminInlineEmptyState.test.ts` 验证 title/description/content fallback、neutral/loading/error 的 status/alert 语义，以及 action slot 的 disabled/hidden 条件。
- `check-admin-empty-state-governance.mjs` 验证单一 inset property、responsive token 映射、registry 和所有 consumer 的禁止覆盖规则。
- `admin-inline-empty-state.spec.ts` correctness E2E 只验证真实可见内容、role/live region、action 可达性、page/console health 和横向可达性，不读取固定 padding 数值。
- `visual/admin-inline-empty-state.spec.ts` 以 article、queue、anonymous 三个代表场景验证 desktop/mobile alignment、hierarchy、overflow，并由语义命名 screenshot baseline 负责细微对齐。

旧 correctness test ID 已映射到新的浏览器语义测试、静态 owner 与视觉诊断；截图不是内容或 action correctness 的唯一 authority。

## 本地验证

```bash
node tests/frontend/checks/static/check-admin-empty-state-governance.mjs
cd src/frontend
vitest run --config vitest.config.ts ../../tests/frontend/unit/components/admin/AdminInlineEmptyState.test.ts
playwright test --config=playwright.config.ts admin-inline-empty-state.spec.ts --workers=1
playwright test --config=playwright.diagnostics.config.ts visual/admin-inline-empty-state.spec.ts --workers=1
```

这些检查不依赖 GitHub Actions，也不设置固定时间门禁。
