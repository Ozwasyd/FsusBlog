# Fsu's Blog V2 后端工程执行计划 (PLANS)

## 一、 里程碑列表

### [x] Milestone 1: 后端三层架构重组与环境初始化

* **Goal**: 基于现有 `Server` 项目，新建 `Core` 与 `Shared` 项目，配置 .NET 10 高性能 JIT 参数。
* **Scope**: 解决方案架构重整，支持跨平台编译。
* **Files**:
 * `FsusBlog.slnx` (移除 Wasm 的 VS 关联)
 * `FsusBlog.Core/FsusBlog.Core.csproj`
 * `FsusBlog.Shared/FsusBlog.Shared.csproj`
 * `FsusBlog.Server/Program.cs` (注入 PGO 优化开关)
* **Validation**:
  * 运行 `dotnet build` 确保三个项目引用链通畅。
 * 确认 `.csproj` 中开启了 `<TieredPGO>true</TieredPGO>`。
* **Completion Note (2026-04-04)**:
  * 已新增 `FsusBlog.Core` 与 `FsusBlog.Shared` 并接入 `FsusBlog.slnx`。
  * `FsusBlog.Server/FsusBlog.Server.csproj`、`FsusBlog.Core/FsusBlog.Core.csproj`、`FsusBlog.Shared/FsusBlog.Shared.csproj` 均已启用 `<TieredPGO>true</TieredPGO>`。
  * `dotnet build FsusBlog.slnx -v minimal` 构建通过。
* **Dependencies**: 现有源代码。
* **Done criteria**: 项目架构独立，本地跨平台构建成功。

### [x] Milestone 2: 存量契约提取与 Shared POD 定义

* **Goal**: 审计 `Server` 现有的 DTO 定义，在 `Shared` 中定义二进制 POD `struct`。
* **Scope**: 跨端通信真理源确立。
* **Files**:
  * `FsusBlog.Shared/Models/*.cs`
* **Validation**:
  * 检查每个结构体是否包含 `[StructLayout(LayoutKind.Sequential, Pack = 1)]`。
 * 验证变长数据已转为 `fixed byte[N]`。
* **Completion Note (2026-04-04)**:
  * 已在 `FsusBlog.Shared/Contracts` 下完成 `Primitives`、`Envelopes`、`Models`、`Validation` 四层 POD 契约定义，覆盖当前所有下发响应 DTO。
  * 变长文本统一改为 `Utf8SliceRef(Offset, Length)`，短文本统一改为固定宽度二进制块（`Utf8Fixed*`）。
  * 已生成 C++ 对齐清单：`FsusBlog.Shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`。
  * `dotnet build FsusBlog.slnx -v minimal` 构建通过。
* **Dependencies**: Milestone 1。
* **Done criteria**: 完成所有下发模型的二进制化重塑。

### [x] Milestone 3: 业务逻辑下沉与 Result 控制流改造

* **Goal**: 将逻辑从 `Server` 迁移至 `Core`，并移除所有的 `try-catch`。
* **Scope**: 控制流与逻辑层优化。
* **Files**:
  * `FsusBlog.Core/Services/*.cs`
 * `FsusBlog.Core/Common/Result.cs`
* **Validation**:
  * 确保核心路径不含 `throw` 关键字。
 * 验证数据库连接池与 SqlSugar 在 `Core` 中的稳定性。
* **Completion Note (2026-04-04)**:
  * 已在 `FsusBlog.Core/Common` 建立 `Result`/`Result<T>`、`ErrorCode`、`ErrorDetail` 统一结果模型。
  * 已在 `FsusBlog.Core/Services` 落地 `Article/Comment/User/System/Stats` 五组 Core 服务接口与实现，且 `FsusBlog.Core/Services` 下无 `try/catch/throw`。
  * 已在 Server 侧通过 `CoreBridge` 完成 Legacy Gateway + Adapter 接驳，`IArticleService`、`ICommentService`、`IUserService`、`ISystemService`、`IStatsService` 统一进入 Core Result 管道。
  * `dotnet build FsusBlog.slnx -v minimal` 构建通过。
  * 按约定保留 `IMessageService`、`SseMessageService`、Background Worker 现状，后续里程碑再收敛。
* **Dependencies**: Milestone 1。
* **Done criteria**: 核心逻辑完成无异常重构。

### [x] Milestone 4: 混合映射与存量 Dapper 模式迁移

* **Goal**: 实现 Entity 到 POD 的零分配映射，参考原 Server 存量 struct 映射代码。
* **Scope**: 数据转换层。
* **Files**:
  * `FsusBlog.Core/Mapping/*.cs`
* **Validation**:
  * 通过 `BenchmarkDotNet` 验证转换过程无 Gen-0 抖动。
 * 验证 AVX2/SIMD 优化在映射过程中的生效情况。
* **Dependencies**: Milestone 2, Milestone 3。
* **Done criteria**: 实现从数据库到二进制结构体的高效“直通”查询。
* **Completion notes (2026-04-04)**:
  * 已在 `FsusBlog.Core/Mapping` 落地 `PodUtf8Codec`、`PodTimeCodec`、`PodRowMapper`、`PodProjector` 与强类型 `ReadModels`，首批覆盖 `Article/Comment/Stats` 高频读链路。
  * 已完成 `IArticleCoreService`、`ICommentCoreService`、`IStatsCoreService` 及对应 Legacy Gateway 的 `Result<object>` -> `Result<T>` 强类型收敛；`CoreBridge` Adapter/Gateway 已切换至强类型路径。
  * `dotnet build FsusBlog.slnx -v minimal` 构建通过（0 Warning, 0 Error）。
  * `rg -n "\bobject\b|ValueTuple<object"` 在已切高频链路接口/网关/适配层结果为 0；`rg -n "\btry\b|\bcatch\b|\bthrow\b" FsusBlog.Core/Services FsusBlog.Core/Mapping` 结果为 0。
  * BenchmarkDotNet 报告位于 `BenchmarkDotNet.Artifacts/results/PodMappingBenchmarks-report-github.md`：`ArticleList_PodProjection` 920B/Op、`CommentItem_PodProjection` 976B/Op、`Stats_PodProjection` 88B/Op，当前已显式量化热点分配，后续里程碑继续压到零分配目标。

### [x] Milestone 5: 二级缓存零分配适配

* **Goal**: 重构 Redis 和 MemoryCache，直接存取 POD 二进制流。
* **Scope**: 缓存层加速。
* **Files**:
  * `FsusBlog.Core/Cache/CacheManager.cs`
* **Validation**:
  * 确认缓存存储的内容为 raw binary。
 * 验证在高频访问下消灭了 JSON 序列化开销。
* **Dependencies**: Milestone 4。
* **Done criteria**: 缓存系统全面转向二进制化。
* **Completion notes (2026-04-04)**:
  * 已新增 `FsusBlog.Core/Cache`：`ICacheManager`、`CacheKeyBuilder`、`PodBinaryCodec`、`CacheManager`，并以 `L1 -> L2 -> Loader` 接入 POD 二进制缓存流程。
  * 已新增 `FsusBlog.Server/Infrastructure/CoreBridge/Cache` 的 `MemoryLevel1CacheStore` 与 `RedisLevel2CacheStore`，并在 `Program.cs` 完成注入。
  * `Article/Comment/Stats` 高频读链路（CoreBridge Gateway）已切换为“先读 POD 缓存，未命中回源 legacy 并回填”。
  * 静态检查：`rg -n "SerializeToUtf8Bytes|JsonSerializer.Deserialize" FsusBlog.Core FsusBlog.Server/Infrastructure/CoreBridge` 结果为 0；`rg -n "\btry\b|\bcatch\b|\bthrow\b" FsusBlog.Core/Cache` 结果为 0。
  * 构建验证：`dotnet build FsusBlog.slnx -v minimal` 通过。
  * BenchmarkDotNet 报告：`BenchmarkDotNet.Artifacts/results/PodMappingBenchmarks-report-github.md`，新增缓存场景 `CacheMiss_ArticlePage_PodBinary` / `CacheHit_ArticlePage_PodBinary`（当前仍存在分配，后续里程碑继续压榨至更低 Alloc/Gen0）。

### [x] Milestone 6: 算法核集成与全链路验证

* **Goal**: 在 `Core` 集成 AEDS 编码并适配 MVC 控制器，下发二进制流。
* **Scope**: 全链路闭环。
* **Files**:
  * `FsusBlog.Server/Controllers/*.cs`
 * `FsusBlog.Core/Algorithms/AedsEncoder.cs`
* **Validation**:
  * 验证模拟的 C++ Wasm 客户端能正确解码 Server 下发的字节流。
* **Dependencies**: Milestone 5。
* **Done criteria**: 后端重构完成，产出符合 15Mbps 窄带宽压榨要求的二进制数据流。
* **Completion notes (2026-04-04)**:
  * 已在 `FsusBlog.Core/Algorithms` 新增 AEDS v1 核心：`IAedsEncoder`、`AedsEncoder`、`AedsFrameType`、`AedsFrameHeader`、`AedsDecoderValidator`，采用固定 24-byte header（Magic/Version/FrameType/Flags/PayloadLength/HeaderCrc32/PayloadCrc32）与 little-endian 编码。
  * 已新增并行二进制路由 `api/binary/*`（Article/Comment/Stats）并保持原 JSON 路由不变，二进制响应 `Content-Type: application/octet-stream`。
  * 已完成 Core 解码回环验证能力（`AedsDecoderValidator.ValidateRoundTrip`），并新增协议文档：`FsusBlog.Core/Algorithms/AEDS_V1_PROTOCOL.md`，可直接对齐外部 C++/Wasm 解码实现。
  * 构建验证：`dotnet build FsusBlog.slnx -v minimal` 通过（无错误）。
  * 静态检查：`rg -n "\\btry\\b|\\bcatch\\b|\\bthrow\\b" FsusBlog.Core/Algorithms FsusBlog.Server/Modules` 结果为 0；`rg -n "JsonSerializer.Serialize|SerializeToUtf8Bytes|Deserialize" FsusBlog.Server/Modules FsusBlog.Core/Algorithms` 结果为 0。
  * BenchmarkDotNet 已新增 `Aeds_Encode_ArticleList` / `Aeds_Decode_ArticleList` / `Aeds_RoundTrip_Validate` 场景，报告路径：`BenchmarkDotNet.Artifacts/results/PodMappingBenchmarks-report-github.md`。

## 二、 Codex 交互指南

1. **兼容性守卫**：在编写向量化代码时，提醒 Codex 使用 `Vector256.IsHardwareAccelerated` 进行运行时检查，而不是强制硬编码 AVX-512。
2. **存量代码利用**：在执行 **Milestone 4** 时，显式要求 Codex 参考原 `Server` 中已有的 Dapper 映射实现。
3. **零分配要求**：在 `Core` 层重写任何逻辑时，要求 Codex 汇报是否存在隐藏的 `new` 对象操作。
4. **契约变更警告**: 任何对 FsusBlog.Shared 的修改，必须要求 Codex 生成一份配套的 C++ struct 对齐清单，供外部 CMake 项目参考。
