<!-- Generated from config/contracts/behavior-contracts.json; digest 05c3c7b07e2f4682a53905a383ad4b713f9bc98d5a72b30410c29ce251f1945e; do not edit by hand. -->

# Behavior Contract Index

此索引完全由 `config/contracts/behavior-contracts.json` 生成；它只列出稳定行为 ID 和机器契约元数据，不承载 Markdown 正文或测试实现。

| Behavior ID | Domain | Risk | Status | Evidence stage | Extractor | Test kinds | Documentation | Release qualification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `test-asset-audit-reconciliation` | testing | high | active | pre-runtime | `test-asset-audit-fact-extractor` | positive, negative | required | yes |
| `code-intent-governance` | governance | high | active | pre-runtime | `code-intent-fact-extractor` | positive, negative | required | yes |
| `document-lifecycle-governance` | documentation | high | active | pre-runtime | `document-lifecycle-fact-extractor` | positive, negative, migration | rationale-only | yes |
| `binary-api-aeds-contract` | api | critical | active | pre-runtime | `openapi-aeds-fact-extractor` | positive, negative | required | yes |
| `browserless-production-correctness` | testing | critical | active | pre-runtime | `test-matrix-fact-extractor` | positive, negative, concurrency | required | yes |
| `authentication-session-permission` | security | critical | active | pre-runtime | `auth-session-permission-fact-extractor` | positive, negative, migration | required | yes |
| `configuration-error-security-policy` | security | critical | active | pre-runtime | `config-error-security-policy-fact-extractor` | positive, negative, boundary | required | yes |
| `article-comment-lifecycle-outbox` | content | critical | active | pre-runtime | `content-lifecycle-fact-extractor` | positive, negative | required | yes |
| `application-runtime-semantic-coherence` | runtime | critical | active | post-runtime | `application-runtime-observation-producer` | positive, negative, boundary | required | yes |
| `release-deployment-runtime-containment` | deployment | critical | active | post-runtime | `release-deployment-observation-producer` | positive, negative, boundary | required | yes |
