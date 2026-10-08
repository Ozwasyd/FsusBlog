<!-- Generated from config/contracts/behavior-contracts.json; digest d905eeb37d0ffe25699eef55aaa9005d940223b2f7962d6d84ac03b3f214bb55; do not edit by hand. -->

# Behavior Contract Index

此索引完全由 `config/contracts/behavior-contracts.json` 生成；它只列出稳定行为 ID 和机器契约元数据，不承载 Markdown 正文或测试实现。

| Behavior ID | Domain | Risk | Status | Extractor | Test kinds | Documentation | Release qualification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-asset-audit-reconciliation` | testing | high | active | `test-asset-audit-fact-extractor` | positive, negative | required | yes |
| `code-intent-governance` | governance | high | active | `code-intent-fact-extractor` | positive, negative | required | yes |
| `document-lifecycle-governance` | documentation | high | active | `document-lifecycle-fact-extractor` | positive, negative, migration | rationale-only | yes |
| `binary-api-aeds-contract` | protocol | critical | active | `openapi-aeds-fact-extractor` | positive, negative | required | yes |
| `browserless-production-correctness` | testing | critical | active | `test-matrix-fact-extractor` | positive, negative, concurrency | required | yes |
| `release-final-aggregate-contract` | release | critical | active | `test-matrix-fact-extractor` | positive, negative | required | yes |
| `deployment-blue-green-runtime-role` | deployment | critical | active | `test-matrix-fact-extractor` | positive, negative, concurrency | required | yes |
| `authentication-session-permission` | security | critical | active | `auth-session-permission-fact-extractor` | positive, negative, migration | required | yes |
| `configuration-error-security-policy` | security | critical | active | `config-error-security-policy-fact-extractor` | positive, negative, boundary | required | yes |
| `article-comment-lifecycle-outbox` | content | critical | active | `content-lifecycle-fact-extractor` | positive, negative | required | yes |
