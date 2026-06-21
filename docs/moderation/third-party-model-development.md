# 第三方审核模型 Provider 开发指南

本文是 FsusBlog 面向第三方反垃圾和内容审核模型开发者的 Provider 契约。`FsusAntiSpamModel` 是第一方参考实现，不是唯一实现。任何 CLI 或 HTTP Provider 只要遵守本文契约，都可以作为 FsusBlog 审核系统的风险信号来源。

## 核心边界

第三方模型 Provider 只提供风险信号。它不能决定评论是否允许发布、是否隐藏、是否地区屏蔽，也不能声明某内容在某地区合法或非法。

FsusBlog 自己负责以下最终动作：

- `ContentFilterService` 和硬词库命中。
- `RegionLegalModerationService` 地区法律策略。
- `blocked_regions` 计算和 viewer region 过滤。
- 管理员人工审核最终裁决。

Provider 可以输出：

- risk categories
- confidence
- severity
- primary_reason
- evidence_policy
- needs_second_round
- model_profile
- threshold_profile
- provider metadata

Provider 不得输出：

- `allow`
- `reject_submit`
- `geo_block`
- `publish`
- `hide`
- `legal_in_region`
- `illegal_in_region`
- `blocked_regions`
- `submit_action`
- `display_action`

如果 Provider 返回这些最终动作字段，FsusBlog 在严格模式下应拒绝响应；开发宽松模式也只能忽略并记录 warning，不能把它们当作最终动作。

## 调用顺序

FsusBlog 审核链路的优先级固定为：

```text
1. Basic payload validation
2. Hard dictionaries / ContentFilterService
3. RegionLegalModerationService
4. Optional model provider risk signal
5. Manual moderation queue
6. Admin final action
```

模型风险信号不能覆盖硬词库拒绝、地区策略拒绝、`blocked_regions` 或管理员最终限制。

## Provider 类型

第一版契约覆盖：

| Provider | 用途 |
|----------|------|
| `none` | 默认关闭，不调用外部模型 |
| `mock` | 测试和开发环境模拟信号 |
| `http-json` | 第三方 HTTP JSON 模型服务 |
| `fsus-cli` | 预留给 `FsusAntiSpamModel` 稳定评分命令的本地 CLI 模型进程 |
| `grpc` | 预留，不在第一版强制实现 |

生产默认建议：

```json
{
  "Moderation": {
    "AntiSpamModel": {
      "Enabled": false,
      "Provider": "none",
      "Mode": "score-only",
      "FailOpen": true,
      "TimeoutMs": 800,
      "ContractVersion": "fsusblog-moderation-provider-v1"
    }
  }
}
```

## Request 契约

权威 schema: [`schemas/moderation/model-provider-request.schema.json`](../../schemas/moderation/model-provider-request.schema.json)

示例：

```json
{
  "contract_version": "fsusblog-moderation-provider-v1",
  "request_id": "01JZ0000000000000000000000",
  "content_type": "comment",
  "text": "example comment text",
  "language": "zh-CN",
  "region_hint": "CN-MAINLAND",
  "threshold_profile": "cn-mainland-strict-v1",
  "max_evidence_items": 8,
  "metadata": {
    "source": "fsusblog",
    "article_id": "123",
    "comment_depth": 0
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `contract_version` | 是 | 固定为 `fsusblog-moderation-provider-v1` |
| `request_id` | 是 | 请求关联 ID，日志和审计使用 |
| `content_type` | 是 | `comment` / `article` / `profile` / `message` |
| `text` | 是 | 待评分文本 |
| `language` | 否 | BCP-47 语言提示，例如 `zh-CN` |
| `region_hint` | 否 | 只作为模型阈值和校准提示，不是法律裁决 |
| `threshold_profile` | 否 | FsusBlog 希望 Provider 使用的阈值 profile |
| `max_evidence_items` | 否 | 限制 evidence 数量 |
| `metadata` | 否 | 非敏感上下文 |

安全要求：

- `metadata` 是 allowlist，不是任意调试字典。允许字段为：`source`、`comment_id`、`article_id`、`comment_depth`、`region_policy_version`、`author_mode`、`anonymous_display_language`、`moderation_subject_hash`、`credential_level`、`reputation_bucket`、`account_age_bucket`、`anonymous_comments_enabled`、`zk_anonymous_enabled`、`anonymous_proof_level`、`anonymous_credential_level`、`anonymous_nullifier_hash`、`anonymous_scope`、`submitted_time_bucket`。
- Request、response metadata、样本导出 fixture 和 provider manifest 都不得包含 `userId`、`username`、`email`、`ip`、`lastIp`、`authorId`、`replyToUserId`、`accountId`、`publicHandle` 或这些字段的 snake_case / lower-case 变体。
- 默认不传明文 IP、email、手机号、cookie、session token、JWT、admin step-up proof。
- 如果需要匿名上下文，只传 FsusBlog 定义的 hash、proof level、credential level、time bucket 或低精度 region hint。

## Provider Manifest 来源守卫

权威 schema: [`schemas/moderation/model-provider-manifest.schema.json`](../../schemas/moderation/model-provider-manifest.schema.json)

生产 provider manifest 必须声明 `source: "mainline-release"` 与 `mode: "production"`。`FsusAntiSpamModel/legacy/python` 只允许作为迁移审计资料，manifest 必须声明 `source: "audit-only"` 与 `mode: "audit-only"`；audit-only manifest 不能进入生产 provider 缓存、模型 bundle 或发布产物。

示例：

```json
{
  "schema": "fsusblog.moderation.provider-manifest.v1",
  "provider_id": "fsus-antispam",
  "model_profile": "mainline-release-v1",
  "contract_version": "fsusblog-moderation-provider-v1",
  "source": "mainline-release",
  "artifact_path": "dist/fsus-antispam/model.json",
  "mode": "production"
}
```

## Response 契约

权威 schema: [`schemas/moderation/model-provider-result.schema.json`](../../schemas/moderation/model-provider-result.schema.json)

示例：

```json
{
  "contract_version": "fsusblog-moderation-provider-v1",
  "request_id": "01JZ0000000000000000000000",
  "provider_id": "example-provider",
  "model_profile": "global-multilabel-v1",
  "threshold_profile": "cn-mainland-strict-v1",
  "status": "scored",
  "label": "risky",
  "confidence": 0.94,
  "severity": "high",
  "primary_reason": "political_sensitive",
  "categories": [
    {
      "id": "political_sensitive",
      "confidence": 0.94,
      "severity": "high",
      "evidence_policy": "redact"
    }
  ],
  "needs_second_round": true,
  "evidence": [],
  "latency_ms": 41
}
```

必填字段：

- `contract_version`
- `request_id`
- `provider_id`
- `model_profile`
- `status`
- `label`
- `confidence`
- `severity`
- `categories`

`status` 可选值：

- `scored`
- `unsupported_language`
- `too_long`
- `empty`
- `provider_error`
- `model_unavailable`
- `contract_mismatch`

`label` 可选值：

- `clean`
- `suspicious`
- `risky`
- `blocked_candidate`

`blocked_candidate` 仍然不是 `reject_submit`。它只表示模型认为风险很高，最终动作仍由 FsusBlog 决定。

## Error 契约

权威 schema: [`schemas/moderation/model-provider-error.schema.json`](../../schemas/moderation/model-provider-error.schema.json)

HTTP Provider 错误响应示例：

```json
{
  "contract_version": "fsusblog-moderation-provider-v1",
  "request_id": "01JZ0000000000000000000000",
  "provider_id": "example-provider",
  "status": "provider_error",
  "error": {
    "code": "MODEL_TIMEOUT",
    "message": "model timed out",
    "retryable": true
  }
}
```

CLI Provider 规则：

- stdout 必须只输出 JSON。
- stderr 可以输出诊断日志，但不得包含敏感明文。
- exit code `0` 表示 stdout 可解析。
- exit code 非 `0` 表示 `provider_error`。

## 风险类别

FsusBlog 第一版 adapter-facing 风险类别：

```text
advertising
contact_lead
scam
spam_repeat
malicious_link
html_risk
pornographic
sexual_explicit
sexual_suggestion
political_sensitive
public_order_risk
national_security_risk
hate_speech
terrorism_extremism
gambling
violence_extreme
child_safety
harassment
```

这些是风险事实标签，不是法律动作。同一条内容可以命中多个 categories。Provider 不需要知道 FsusBlog 最终如何处理这些 categories。

## Severity、Confidence 和 Evidence Policy

`severity` 可选值：

```text
low
medium
high
critical
```

`confidence` 范围：

```text
0.0 <= confidence <= 1.0
```

`evidence_policy` 可选值：

```text
show_full
show_category_only
redact
```

政治、安全、未成年人、色情等高风险类别建议使用 `redact`。Provider 不应把敏感词明文写入普通 evidence、stdout 或 stderr。

## region_hint 和 threshold_profile

`region_hint` 和 `threshold_profile` 只是阈值和校准提示。

示例：

```text
region_hint = CN-MAINLAND
threshold_profile = cn-mainland-strict-v1
```

含义是“请使用更保守阈值输出风险信号”，不是“请判断中国大陆是否合法”。Provider 不能返回 `legal_in_region`、`illegal_in_region`、`blocked_regions`、`submit_action` 或 `display_action`。

## HTTP JSON Provider

Provider endpoint:

```text
POST /v1/moderation/score
Content-Type: application/json
```

FsusBlog 侧配置示例：

```json
{
  "Provider": "http-json",
  "Endpoint": "http://127.0.0.1:8787/v1/moderation/score",
  "TimeoutMs": 800,
  "ExternalProviderReviewed": true
}
```

行为约定：

- `2xx + valid JSON` 表示 scored 或结构化非致命状态。
- `4xx` 表示配置或请求错误。
- `5xx` 表示 Provider 故障。
- timeout 表示 Provider 超时，评论仍进入 Pending。

HTTP Provider 如果运行在外部机器，必须由管理员显式确认，并通过外部 Provider 安全评审。

## CLI JSON Provider

CLI 示例：

```bash
third-party-moderation score --input-json - --output-json
```

FsusBlog 调用约定：

```text
stdin: request JSON
stdout: response JSON only
stderr: diagnostic logs only
exit code 0: response parsed
exit code non-zero: provider_error
```

配置示例：

```json
{
  "Provider": "cli-json",
  "ExecutablePath": "third-party-moderation",
  "ArgumentsTemplate": "score --input-json - --output-json",
  "TimeoutMs": 800
}
```

## Conformance Test Kit

仓库提供最小兼容性测试工具：

```bash
node tools/moderation/provider-conformance.mjs \
  --provider cli-json \
  --executable node \
  --args "examples/moderation-providers/cli-json-node/provider.mjs"
```

HTTP 示例：

```bash
node examples/moderation-providers/http-json-node/server.mjs --port 8787
node tools/moderation/provider-conformance.mjs \
  --provider http-json \
  --endpoint http://127.0.0.1:8787/v1/moderation/score
```

工具会检查：

- request schema。
- result schema。
- error schema。
- CLI stdout-only JSON。
- HTTP JSON 响应。
- forbidden final-action fields。
- unknown category 拒绝。
- `region_hint` 只作为提示。
- timeout 不绕过 Pending 语义。
- contract mismatch 以结构化错误表达。

## 示例 Provider

示例目录：

- [`examples/moderation-providers/cli-json-node/`](../../examples/moderation-providers/cli-json-node/)
- [`examples/moderation-providers/http-json-node/`](../../examples/moderation-providers/http-json-node/)

示例只做 mock scoring，不包含真实敏感词。

## 版本兼容

当前契约版本：

```text
fsusblog-moderation-provider-v1
```

兼容规则：

- patch: 新增可选字段，兼容。
- minor: 新增 category 或可选能力，Provider 应忽略未知 request 字段。
- major: 破坏 schema，需要显式升级。

第三方 Provider 必须返回：

- `contract_version`
- `provider_id`
- `model_profile`

## FsusBlog 运行时降级

FsusBlog 默认策略：

```text
Enabled=false
Provider=none
Mode=score-only
FailOpen=true
TimeoutMs=800
```

模型故障时：

- Provider timeout -> 记录 timeout/unavailable signal，评论进入 Pending。
- Provider invalid JSON -> 记录 contract invalid signal，评论进入 Pending。
- Provider unavailable -> 记录 unavailable signal，评论进入 Pending。
- Provider contract mismatch -> 记录 contract mismatch signal，评论进入 Pending。

地区策略故障不是模型故障，不能 fail-open 到公开发布；地区策略失败应进入 `manual_review_no_public_display` 或保守模式。

## 开发者清单

- 实现 HTTP 或 CLI JSON 入口。
- 使用 `fsusblog-moderation-provider-v1`。
- 只输出风险信号。
- 不输出最终动作字段。
- 不输出 `blocked_regions`。
- 不把 `region_hint` 当作法律判断。
- 不把敏感词明文写入普通日志。
- 通过 `tools/moderation/provider-conformance.mjs`。
- 在部署文档中声明 model profile、threshold profile、日志策略和数据保留策略。

## 与其他设计的关系

- `#70`: FsusBlog 模型 Provider 接入实现。
- `#73`: 地区法律审核与 geo-blocking。
- `#74`: 多地区/通用词库架构。
- `#75`: 后台审核系统控制台。
- `#77`: 运行时热插拔和安全降级。
- `FsusAntiSpamModel#12`: 参考模型实现。

设计底线：

```text
FsusBlog 定义外部 Provider 协议；
第三方模型实现协议；
模型输出风险信号；
地区策略决定法律动作；
词库硬规则优先于模型；
人工审核保留最终控制权。
```
