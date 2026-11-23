# AEDS v2 二进制协议

> **角色**：协议规范
> **适用对象**：后端、前端与协议校验维护者
> **权威依据**：帧类型、布局常量、显式宽度枚举、嵌入记录与字段定义以 [`src/Contracts/wire.schema.json`](../src/Contracts/wire.schema.json) 为单一事实来源。

## 1. 外层帧格式与编码约束

- **外层帧头**：固定 16 字节小端标头，包含魔数、协议版本 `2`、标头大小、零保留标志、帧类型、载荷字节数与载荷 CRC-16。未知类型、非 `2` 版本、非零标志、超出长度预算或 CRC 不匹配一律 fail-closed 拒绝。
- **HTTP 媒体类型**：运行时业务接口统一使用 `application/octet-stream`，不提供 JSON 业务回退（`GET /integrity/keys.json`、`GET /manifest.webmanifest`、Feed/Sitemap 等标准公开文档除外）。
- **基础类型编码**：
  - 扩展 v2 帧使用高位编号（`32768+`）。
  - `UUID` 采用标准文本顺序的 16 字节；文本字段采用紧邻在前的有符号小端 `int32` 字节数加严格 UTF-8。
  - 代次（`generation`）与修订号（`revision`）采用 `int64`（浏览器以 `bigint` 处理）；布尔值仅接受字节 `0` 或 `1`。
  - `ApiError (251)` 保留 584 字节 POD（错误码、分类、HTTP 状态、消息、详情、trace ID），响应 HTTP 状态码必须与 POD 内声明一致；`EmptySuccess (240)` 保留 4 字节 POD。

## 2. Schema 驱动的代码生成

`src/Contracts/wire.schema.json` 保存路由常量、帧类型、显式宽度枚举（`enums`）、嵌入记录（`embeddedRecords`）、字段组（`fieldGroups`）与业务载荷定义（含嵌套 `record` 与有界 `list`）。

```sh
# 修改 wire.schema.json 后同步生成 C# / TypeScript / C++ 构件
node tools/protocol-generate.mjs

# 校验生成物未漂移
node tools/protocol-generate.mjs --check
```

严禁手改生成输出（`Wire.Generated.cs`、`wire.generated.ts`、`wire.generated.hpp`）。跨字段业务语义校验与可变偏移编解码保留在各领域 `*Wire.cs` 与 TypeScript 模块中（例如 `AdminSignInHistory` 帧 `32963` 的代次与时间边界校验位于 `AdminSignInHistoryWire.cs` 与 `admin-session-history.ts`）。

## 3. 核心路由与载荷家族概览

服务端现已覆盖公开阅读、检索、身份认证、创作工作区、评论治理、站内信与管理后台全部业务接口；下表列出核心公开与基础通道，其余业务域端点与帧号详见对应 [功能契约](index.md#功能契约按业务域分组) 与 `src/Contracts/wire.schema.json`：

| 路径 | 载荷与语义 |
| --- | --- |
| `GET /api/binary/article/list/home/{page}/{size}.aeds` | `ArticleList (1)`，FSPA v2（100 字节记录，不含旧 56/76 字节记录或 cursor v1） |
| `GET /api/binary/article/list/archive/{page}/{size}.aeds` | `ArticleList (1)`，独立归档游标作用域 |
| `GET /api/binary/article/{id}.aeds` | `ArticleDetail (2)`，ARD5（排除旧 ARD3/ARD4），含分类、标签与发布权利摘要 |
| `GET /api/binary/article/hot/{size}.aeds` | `ArticleHot (3)`，1–100 条已验证阅读热门榜单（内存预编码，热读零数据库查询） |
| `GET /api/binary/article/{articleId}/related.aeds` | `ArticleRelatedReading (27)`，最多 6 条同分类/标签推荐及前后篇导航（每快照最多缓存 256 条） |
| `GET /api/binary/article/search/query.aeds?q=…` | `ArticleSearch (4)`，零数据库查询的服务端 FAS4 倒排检索 |
| `GET` / `HEAD /api/v2/public/search-corpus` | 紧凑档静态 FSPK v4 / FHS2 v4 分片（强 ETag 支持 `304`，`HEAD` 校验代次返回 `204`/`409`） |
| `GET` / `HEAD /api/v2/public/search-corpus/wide/v1/*` | 宽语料清单（AEDS `33004`）与分片页（支持 25,601–100,000 篇公开文章） |
| `GET /api/v2/identity/session.aeds` | `OperatorSession (32769)`，仅接受读者会话 Cookie |
| `GET /api/v2/admin/identity/session.aeds` / `/api/v2/authoring/session.aeds` | 管理员与创作会话状态，仅接受管理员会话 Cookie |
| `GET /api/v2/authoring/draft/{id}.aeds`、`POST /api/v2/authoring/{save,publish,retract,delete}.aeds` | 私有草稿读写与发布生命周期（`Draft 32770`、`ArticleCommand 32771`） |

## 4. 游标、排序与搜索格式边界

- **列表游标与排序**：首页和归档列表签发 15 分钟有效加密游标（第 1 页无游标，后续传 `nextCursor`），绑定当前公开代次、路由作用域、页码、页大小、关键词、排序与末篇发布坐标；重启或代次变更后旧游标返回 `400 article_cursor_invalid`。列表 `latest` 按创建时间与文章 ID 倒序；带关键词时默认 `relevance`（字面匹配、保留大小写，避免 SQL `LIKE` 通配符扩展）。热门榜单通过独立的 `/api/binary/article/hot/{size}.aeds` 提供（见 [公开热门文章](product/public-hot-articles.md)）。
- **相关阅读**：从同分类或标签候选中取最新至多 120 篇综合评分返回前 6 条，未发布或已撤回源统一返回 AEDS `404`；请求携带 `publication` 且已变更时返回 `409`。
- **搜索分片与增量刷新**：公开搜索在 `auto`/`local`/`server` 三模式下协调本地 FSPK v4 分片（含共享词表/停用词分词、同源 IndexedDB 缓存、强 ETag `304` 与 FSPT v4 增量补丁）、宽语料分片与服务端 FAS4。完整规则见 [本地全文检索](product/public-search.md) 与 [公开 FAS4 服务端检索](product/fas4-search.md)。

## 5. 跨语言协议校验

```sh
FSUS_DOTNET=/path/to/dotnet ./tools/protocol-test.sh
```

- `tests/Protocol/FsusBlog.V2.ProtocolTests.csproj` 是接收夹具目录参数的独立控制台程序（不由 `dotnet test` 运行）；仅编译解决方案不代表协议向量已执行，必须运行 `./tools/protocol-test.sh`。
- 套件同时验证 C#、TypeScript、本机 C++ 与离线构建的 wasm32 标头/CRC 验证器（含数千项 JS/Wasm 外层帧差分），并对各业务载荷执行独立正反向字节向量测试（覆盖空/满列表、非法枚举、全截断、越界与跨字段组合拒绝）。
