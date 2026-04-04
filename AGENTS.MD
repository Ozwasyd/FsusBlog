# AGENTS 工程控制规则 (跨平台优化版)

本文件定义了 Fsu's Blog V2 后端重构的执行准则。核心任务是将现有的普通 .NET 10 代码重构为基于二进制契约的高性能架构。

## 1. 核心架构与项目职责

* **FsusBlog.Server (存量重构)**：Web 宿主，基于 ASP.NET Core 10 MVC。负责路由、DI、配置加载。
* **FsusBlog.Core (新建项目)**：算法与逻辑引擎。承载从 Server 迁移出的业务逻辑、SqlSugar 仓储、二级缓存管理及 AEDS 算法。
* **FsusBlog.Shared (新建项目)**：**二进制契约真理源**。仅存放 `readonly struct`。
  * **物理布局**：必须使用 `[StructLayout(LayoutKind.Sequential, Pack = 1)]`。
 * **跨端对齐**：其内存排布必须与外部 CMake 项目 (FsusBlog.Wasm) 严格一致。

## 2. 技术栈与环境约束

* **运行时**：.NET 10 (标准运行时，不使用 NativeAOT)。
* **跨平台**：代码必须兼容 Windows 和 Linux。禁止硬编码 Linux 专有路径或 Docker 特有逻辑。
* **硬件加速**：支持 AVX2。利用 `Vector256<T>` 进行硬件加速，其他向量化优化交由 .NET JIT 自动处理。
* **数据组件**：SqlSugar ORM, PostgreSQL, Redis, IMemoryCache。

## 3. 类型使用准则 (混合模型)

* **持久化模型 (Entities)**：保留为 `class`。由 SqlSugar 管理。
* **通信模型 (PODs)**：位于 `Shared` 层，必须为 `readonly struct`。用于二进制流下发。
* **性能查询**：参考原 Server 存量代码中的 Dapper 风格映射，实现将查询结果直接填充至 `Shared` 结构体，减少堆分配。

## 4. 修改边界与禁令

* **允许修改 (🟢 绿区)**：
  * `FsusBlog.Core/**/*.cs` (业务逻辑零分配重构)
 * `FsusBlog.Shared/**/*.cs` (二进制契约定义)
 * `FsusBlog.Server/**/*.cs` (控制器适配与 DI 调整)
* **禁止修改 (🔴 红区)**：
  * ❌ 禁止修改外部 `FsusBlog.Wasm` 目录（CMake 项目）。
  * ❌ 禁止修改外部 `FsusBlog.Client` 目录（Vue 项目）。
 * ❌ 禁止在 `Shared` 层引入 `string` 或任何引用类型。
 * ❌ 禁止移除 SqlSugar 的 Entity 映射配置。

## 5. 验证流

1. **构建验证**：`dotnet build`。
2. **性能审计**：确保 `Core` 层的转换逻辑没有产生额外的 gen-0 分配。
3. **契约校验**：使用 `Unsafe.SizeOf<T>()` 确认结构体长度，确保其能被 C++ 正确解析。