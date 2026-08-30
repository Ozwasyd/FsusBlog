<!-- Generated from config/contracts/behavior-contracts.json; digest 05fc7505ff1df2050454549f5ac0eca67a22029a5247b5508d5f674c6350edff; do not edit by hand. -->

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
