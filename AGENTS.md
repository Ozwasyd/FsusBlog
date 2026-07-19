# AGENTS.md — FsusBlog Code Agent 操作规范

本文件定义代码代理（Code Agent）的角色边界、修改前核验和交付要求。
通用代码风格不在此重复维护，统一遵循 [跨语言编码规范](docs/development/coding-conventions.md)。文档的当前事实源、issue handoff 与历史快照按 [文档生命周期](docs/development/document-lifecycle.md) 分类。
首选语言：中文；代码名词、路径、命令保留英文。

---

## 编码规范

- `docs/development/coding-conventions.md` 是跨语言代码风格入口，以 Microsoft .NET C# 约定为母规范。
- 外部 wire/ABI/数据库/第三方契约和语言语法优先；formatter、linter 与个人 IDE 设置不得覆盖仓库规范。
- generated、vendor、fixture 与外部名称例外必须使用规范中登记的分类，不得在本文件另建同级规则。

---

## 快速导航（仓库地图）

| 目录 / 文件 | 职责 |
| ------------ | ------ |
| `src/backend/Program.cs` | 中间件链 + 路由注册收口 |
| `src/backend/Modules/Endpoints/` | 所有 Minimal API 端点定义 |
| `src/backend/Infrastructure/` | 缓存 / 安全 / 中间件 / 启动校验等横切关注点 |
| `src/backend/Infrastructure/Cache/` | L1 内存缓存、L2 Redis 缓存、失效入口 |
| `src/backend/Infrastructure/Auth/` | JWT、Cookie、认证服务 |
| `src/backend/Infrastructure/Helpers/JwtHelper.cs` | JWT 签发与校验 |
| `src/backend/Infrastructure/Filters/BannedUserMiddleware.cs` | 登录账号状态与封禁写操作中间件 |
| `src/backend/Infrastructure/Middlewares/` | ShieldMiddleware / GlobalException / ApiBinaryResponse |
| `src/backend/Infrastructure/Operations/ProductionStartupValidator.cs` | 生产启动校验 |
| `src/backend/Infrastructure/PublicAot/` | AOT 公开页壳层 |
| `src/backend/Infrastructure/NotificationStream/` | notification stream 连接管理、背压、事件分发 |
| `src/shared/Contracts/` | 前后端共享 DTO、notification stream 信封、AOT 契约 |
| `src/shared/Contracts/Outputs/ServerResponseContracts.cs` | 所有响应 DTO 定义 |
| `src/shared/Contracts/NotificationStream/NotificationStreamContracts.cs` | notification stream 事件类型与信封 |
| `src/shared/Contracts/Envelopes/PodEnvelopes.cs` | POD 分页 / 游标信封 |
| `src/core/Algorithms/` | AEDS 编解码算法核心 |
| `src/core/Algorithms/AedsFrameType.cs` | 帧类型枚举（权威来源） |
| `src/core/Algorithms/AEDS_V2_PROTOCOL.md` | 二进制帧协议规格（当前运行时只接受 v2） |
| `src/zk/circuits/` | 手写 ZK circuit 领域源码（generated artifact 仍在 `artifacts/zk/`） |
| `src/frontend/wasm/aeds/` | C++23 AEDS 解码器源码（include/ + src/） |
| `src/frontend/wasm/web/aeds.ts` | AEDS C++/TypeScript runtime glue |
| `src/frontend/src/workers/wasmDecode.worker.ts` | Wasm 解码 Web Worker |
| `docs/api/design.md` | API 设计哲学（改 API 前必读） |
| `docs/api/contracts.md` | 请求/响应契约完整文档（改 API 前必读） |
| `docs/api/quick-reference.md` | 路由速查表 |
| `docs/api/schemas-and-errors.md` | 错误码、AEDS 帧格式、POD 大小目录 |
| `docs/architecture.md` | 架构全景（改缓存 / 中间件顺序前必读） |
| `docs/security.md` | 安全模型（改鉴权前必读） |

---

## 代理角色边界

### ServerContractAgent

#### 负责范围

- `src/shared/`、`src/core/`
- `src/backend/Modules/Endpoints/`
- `src/backend/Infrastructure/`
- `src/backend/Program.cs`

#### 允许操作

- 修改端点注册与中间件顺序（仅在已有设计范围内，须同步 `docs/architecture.md`）
- 新增 / 调整 `ApiContract` 与 `AedsFrameType`（满足 `Core`/`Client` 协同前提）
- 调整鉴权策略与校验路径

#### 禁止操作

- 无需求不改 `src/frontend/wasm/aeds/**` 的 C++ 实现
- 未更新 `docs/api/design.md` + `docs/api/contracts.md` 前不推送 API 变更
- 未核验就改 `MapProductionHealthEndpoints`、生产启动校验行为
- 删除对 `X-Fsus-*` 约定头、PoW 验证链或统一响应模型的支持

### WasmEngineAgent

#### 负责范围

- `src/frontend/wasm/aeds/include/**`
- `src/frontend/wasm/aeds/src/**`

#### 允许操作

- 修改 Wasm 解码器、协议映射、类型解析流程
- 优化边界回退策略（Wasm binary decoder → TypeScript binary decoder / 协议错误）

#### 禁止操作

- 修改业务路由、鉴权逻辑、JWT/Passkey 核心流程
- 修改 Vue 状态或 Worker 上层业务分发逻辑

### InteropGlueAgent

#### 负责范围

- `src/frontend/wasm/web/aeds.ts`
- `src/frontend/src/workers/wasmDecode.worker.ts`
- `src/frontend/src/workers/` 内与 API 通道相关文件

#### 允许操作

- 调整协议解析参数、超时 / 回退策略
- 增加错误处理分支、回退阈值与可观测性上报

#### 禁止操作

- 修改 Wasm 核心解码器本体
- 直接改动数据库 / 服务端安全鉴权路径
- 改变现网 API 语义（仅承载 / 回退）

---

## 修改前必读清单

### API 变更

1. 阅读 `docs/api/design.md`、`docs/api/contracts.md`
2. 对照 `docs/api/quick-reference.md`、`docs/api/schemas-and-errors.md`
3. 核验 `src/backend/Program.cs` 路由注册与中间件顺序
4. 核验 `src/backend/Modules/Endpoints/` 全量端点现状
5. 形成变更单：新增 / 移除 / 重命名 / 参数变更

### 缓存策略变更

1. 阅读 `docs/architecture.md`（缓存分层与顺序）
2. 核验 `src/backend/Infrastructure/Cache/*.cs`
3. 核对 `UseOutputCache`、`CacheOutput` 标记
4. 核对 L1/L2 回填与失效入口（`IHttpCacheInvalidator`）

### 鉴权 / 会话变更

1. 阅读 `docs/security.md`
2. 核验以下五个关键文件：
    - `src/backend/Infrastructure/Helpers/JwtHelper.cs`
    - `src/backend/Infrastructure/Auth/AuthCookieService.cs`
    - `src/backend/Infrastructure/Filters/BannedUserMiddleware.cs`
    - `src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs`
    - `src/backend/Infrastructure/Operations/ProductionStartupValidator.cs`

### 二进制协议变更

1. 阅读 `docs/api/contracts.md`、`src/core/Algorithms/AEDS_V2_PROTOCOL.md`
2. 核验三个算法文件：
    - `src/core/Algorithms/AedsFrameType.cs`
    - `src/core/Algorithms/AedsEncoder.cs`
    - `src/core/Algorithms/AedsDecoderValidator.cs`
3. 核对端点与中间件：
    - `src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs`
    - `src/backend/Infrastructure/Middlewares/ApiBinaryResponseMiddleware.cs`
4. 同步更新 `src/shared/Contracts/Validation/PodSizeCatalog.cs` 中的尺寸常量
5. 同步核验 `src/frontend/wasm/aeds/` 与 `src/frontend/wasm/web/aeds.ts` 的解码逻辑

---

## 常见代码模式

### 端点注册模式（Minimal API）

```csharp
// src/backend/Modules/Endpoints/Xxx/XxxEndpoints.cs
public static class XxxEndpoints
{
    public static IEndpointRouteBuilder MapXxxEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/Xxx")
            .WithTags("Xxx");

        // 公开端点
        group.MapGet("/", HandleListAsync)
            .AllowAnonymous()
            .CacheOutput("Public_60s");

        // 鉴权端点
        group.MapPost("/", HandleCreateAsync)
            .RequireAuthorization();

        return app;
    }
}
// 在 Program.cs 中挂载：
// app.MapXxxEndpoints();
// 账号封禁写限制由全局 BannedUserMiddleware 统一执行。
```

### 统一响应包装模式

```csharp
// 成功响应
return Results.Ok(new ApiResponse<T>(data));

// 失败响应（使用错误码枚举）
return Results.BadRequest(ApiResponse.Fail(ErrorCode.XxxInvalid, "描述"));

// 分页响应
return Results.Ok(new ApiResponse<PageResponse<T>>(
    new PageResponse<T>(items, total, page, pageSize)));
```

### 缓存键约定

```csharp
// CacheKeyBuilder 提供所有标准键
CacheKeyBuilder.ArticleList(page, pageSize)
CacheKeyBuilder.ArticleDetail(id)
CacheKeyBuilder.PublicAotShell(pageId, routeKey)
// 失效时通过 IHttpCacheInvalidator 统一清除
```

### Binary 端点模式

```csharp
// Binary 端点是运行时主 API；不得新增旧文本 API fallback。
group.MapGet("/article", async (IAedsEncoder aeds, ...) =>
{
    var payloadResult = await service.GetPageListAsync(...);
    if (payloadResult.HasCachedFrame)
    {
        return BinaryResults.PreencodedFrame(payloadResult.CachedFrame!);
    }

    return BinaryResults.FromResult(
        payloadResult.Result,
        aeds,
        AedsFrameType.ArticleList,
        static (value, writer) => PodBinaryCodec.WriteArticlePage(value, writer));
});
```

`BinaryResults.Frame` 返回 `BinaryFrameResult`，通过 `AedsFrameBufferWriter` 构造新帧；已缓存的完整帧使用 `BinaryResults.PreencodedFrame` 返回 `BinaryPreencodedFrameResult`，不得退回通用 stream response 拼装旧式响应。

---

## 交付标准

涉及 API 或安全边界改动时，输出必须包含：

1. **文档更新清单**（至少 2 个文档文件）
2. **风险与回退路径**（如何在不重启的情况下降级）
3. **已测场景覆盖**（最少包含：匿名请求、登录请求、admin 请求、notification stream、binary）

优先最小修改：尽量在现有过滤器 / 服务边界内扩展，不破坏链路。

---

## 各子项目修改策略速查

| 子项目 | 允许 | 禁止 |
| -------- | ------ | ------ |
| `FsusBlog.Server` | 端点增删改、中间件顺序（须同步 `docs/architecture.md`）、安全过滤器、健康探针 | 未经文档核验直接推送 API 变更；删除 `X-Fsus-*` 头或 PoW 链支持 |
| `FsusBlog.Client` | 修正 API 客户端模型、工具脚本、E2E 用例与文档一致性 | 未同步 `docs/api/contracts.md` 前重命名/移除 binary/json 字段；改写解码行为破坏旧缓存兼容性 |
| `FsusBlog.Shared` | 共享模型、响应包装、NotificationStream/Security/Binary 契约结构体更新 | 删除 `ApiResponse` 与统一错误码语义；引入序列化/类型不兼容变更 |
| `FsusBlog.Core` | POD/解码算法增强、AEDS 编解码优化、与 `Client/wasm` ABI 对齐 | 引入 HTTP 层细节（路由/Controller/Cookie）进入 Core；更改协议文档时不同步 `docs/api/contracts.md` |
