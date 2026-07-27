<!-- Generated from config/contracts/behavior-contracts.json; digest f6572db28b4856e748d7e064267dcae9acba5b892e5e3e73c36a8228a6773795; do not edit by hand. -->

# Behavior Contract Index

此索引完全由 `config/contracts/behavior-contracts.json` 生成；它只列出稳定行为 ID 和机器契约元数据，不承载 Markdown 正文或测试实现。

| Behavior ID | Domain | Risk | Status | Extractor | Test kinds | Documentation | Release qualification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-asset-audit-reconciliation` | testing | high | active | `test-asset-audit-fact-extractor` | positive, negative | required | yes |
| `code-intent-governance` | governance | high | active | `code-intent-fact-extractor` | positive, negative | required | yes |
| `document-lifecycle-governance` | documentation | high | active | `document-lifecycle-fact-extractor` | positive, negative, migration | rationale-only | yes |
| `browserless-production-correctness` | testing | critical | active | `test-matrix-fact-extractor` | positive, negative, concurrency | required | yes |
