<!-- Generated from config/contracts/behavior-contracts.json; digest 47e308f89c12464ef9379baeaaf27a42f41cc29dc3d603579add9e8ef66715b8; do not edit by hand. -->

# Behavior Contract Index

此索引完全由 `config/contracts/behavior-contracts.json` 生成；它只列出稳定行为 ID 和机器契约元数据，不承载 Markdown 正文或测试实现。

| Behavior ID | Domain | Risk | Status | Extractor | Test kinds | Documentation | Release qualification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-asset-audit-reconciliation` | testing | high | active | `test-asset-audit-fact-extractor` | positive, negative | required | yes |
| `code-intent-governance` | governance | high | active | `code-intent-fact-extractor` | positive, negative | required | yes |
| `document-lifecycle-governance` | documentation | high | active | `document-lifecycle-fact-extractor` | positive, negative, migration | rationale-only | yes |
| `binary-api-aeds-contract` | api | critical | active | `openapi-aeds-fact-extractor` | positive, negative | required | yes |
| `browserless-production-correctness` | testing | critical | active | `test-matrix-fact-extractor` | positive, negative, concurrency | required | yes |
