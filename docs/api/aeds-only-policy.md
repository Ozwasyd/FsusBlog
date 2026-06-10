# Internal Application API AEDS-only Policy

本文档定义 FsusBlog 的协议治理规则：**Internal Application API AEDS-only**。

目标是把浏览器与服务端之间的内部应用协议收敛到 AEDS v2 frame，避免继续扩散 `JsonApiResponse<T>`、`response.json()` 和 JSON error envelope。RSS、健康探针、JSON Feed、构建工具和第三方 provider contract 不属于内部应用 API，不强制 AEDS 化。

## 内部应用 API 定义

满足任一条件的端点属于内部应用 API：

- 由 FsusBlog 前端运行时直接调用，用于站点 UI、公开阅读、认证、作者后台、管理后台、通知或遥测。
- 位于 `/api/**`，且不是标准协议、健康探针、构建/运维工具专用入口。
- 返回业务 DTO、错误 envelope、分页数据、操作结果或管理控制台数据。

内部应用 API 的默认选择是：

```text
request:  application/octet-stream AEDS v2 frame
response: application/octet-stream AEDS v2 frame
error:    AedsFrameType.ApiError
```

## AEDS-only 目标

- 新内部应用 API 必须使用 AEDS request/response frame。
- 写操作成功优先返回 `EmptySuccess` 或 `MutationId`。
- 失败、鉴权拒绝、限流、协议错误和异常兜底统一返回 `ApiError` frame。
- 前端必须通过 binary adapter 解码，不得新增内部 `response.json()` 调用。
- 新增 frame type、POD codec、Wasm/TS adapter 时必须同步 golden fixture 或 contract/static test。

## 允许豁免

以下路径允许保留 JSON/XML/text，并必须登记在 `tools/contracts/aeds-only-policy.allowlist.json`：

| 范围 | 路径 / contract | 理由 |
|------|------------------|------|
| Health | `/health/live`, `/health/ready` | Kubernetes/systemd/监控探针消费 JSON |
| Feed | `/feed/rss.xml`, `/feed/atom.xml`, `/feed/feed.json` | RSS/Atom/JSON Feed 标准协议 |
| SEO | `/sitemap.xml`, `/robots.txt` | 搜索引擎标准入口 |
| PublicAOT tooling | `/internal/public-aot/manifest` | 构建/backfill 工具 manifest，非浏览器运行时 API |
| Third-party moderation provider | HTTP JSON provider contract | 外部 provider 兼容协议 |
| Evidence/tool/docs | `.tmp/release-evidence/**`, `tools/**`, `docs/**`, tests | 构建、测试、审计、证据文件，不是 runtime API |

豁免不得使用宽泛通配。每个登记项必须绑定具体文件、路径/范围、匹配 pattern 和理由。

## 必须迁移清单

当前允许作为迁移期兼容层存在的内部 JSON API：

| 范围 | 当前路径 | 迁移 issue |
|------|----------|------------|
| Deprecated public related-reading JSON compatibility | `/api/public/articles/{articleId}/related` | #105 |
| Human read proof | `/api/read-proof/challenge`, `/api/read-proof/submit` | #99 |
| RUM telemetry | `/api/telemetry/rum` | #101 |
| Authoring / moderation / ops | `/api/author/**` | #102 |
| Admin security console | `/api/admin/security/**` | #103 |
| Notification preflight error envelope | `/api/notifications/stream/preflight` | #105 |
| Subscription form API | `/api/subscriptions` | #105 |

这些路径可以继续使用 `JsonApiResponse<T>`，但只能在 allowlist 中登记的文件和 pattern 内出现。迁移完成后必须删除对应 allowlist 项。

## 新端点选择规则

1. 浏览器运行时调用的新 `/api/**` 端点默认使用 AEDS。
2. 如果认为必须返回 JSON/XML/text，先判断是否属于外部标准协议、健康探针、构建工具或第三方 provider contract。
3. 合法豁免必须新增 allowlist entry，并在文档中写明路径、consumer、保留理由和退出条件。
4. 不确定时按内部应用 API 处理，使用 AEDS。

## 错误语义

内部应用 API 错误统一映射到 `AedsFrameType.ApiError`：

```text
ErrorCode
HTTP status
trace id
message
details / reason code
```

JSON envelope 错误只允许在豁免链路和迁移期兼容层使用。新增业务错误码必须同步 `docs/api/schemas-and-errors.md`、AEDS golden fixture 或 contract test。

## 前端 adapter 规则

- 内部 API 必须通过 `requestBinaryOnly`、frame adapter 或明确的 AEDS request codec 调用。
- 不得在 `src/frontend/src/api/**` 新增未登记的 `response.json()`、`Accept: application/json`、`Content-Type: application/json` 或 `JSON.stringify` request body。
- 迁移期 JSON adapter 必须集中在登记文件中，不能在 Vue component 或 composable 内散落解析逻辑。
- AEDS adapter 必须覆盖成功 frame、`ApiError`、wrong content-type、wrong frame type 和 decoder failure。

## Gate 与 Inventory

协议治理由以下文件执行：

```text
tools/contracts/aeds-only-policy.allowlist.json
tools/contracts/check-aeds-only-policy.mjs
tools/check-aeds-only-policy.sh
```

脚本扫描后端 endpoint/health/preflight 文件与前端 runtime API adapter 文件，输出：

```text
.tmp/gate-logs/aeds-only-policy-inventory.json
```

分类：

| 分类 | 含义 | Gate 行为 |
|------|------|-----------|
| `allowed-exemption` | 标准协议、健康探针、工具专用 JSON | 允许 |
| `must-migrate` | 已登记的迁移期内部 JSON | 允许，但必须绑定 issue |
| `test-tool-docs-only` | 测试/工具/文档 JSON | 允许，不扫描 runtime |
| `unknown` | 未登记 JSON 残留 | 阻断 |

`static-governance` 会运行 `tools/check-aeds-only-policy.sh`。新增 JSON 使用必须先登记，否则 fast gate 失败。

## Contract 要求

新增或迁移 AEDS API 时至少同步：

- `src/core/Algorithms/AedsFrameType.cs`
- `src/shared/Contracts/Validation/aeds-protocol.json`
- 对应 POD codec / TS adapter / Wasm decoder 映射
- golden fixture 或 contract/static test
- `docs/api/contracts.md` 与 quick reference

迁移完成的 JSON 路径必须删除 allowlist 中的 `must-migrate` entry，并确认 scanner inventory 不再出现对应项。
