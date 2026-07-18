# Coding conventions

本文件是 FsusBlog 唯一的跨语言编码规范。`AGENTS.md` 只定义代码代理的角色边界和操作流程；安全、协议、数据库与发布文档继续约束各自领域语义，但不另起一套同级代码风格。

母规范采用 Microsoft Learn 的 [.NET coding conventions](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/coding-conventions) 和 [C# identifier naming rules](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names)。仓库规则把这些约定映射到其他语言；formatter 和 linter 是执行器，不是规范来源。

## Priority

发生冲突时严格采用以下优先级：

```text
外部 wire / ABI / 数据库 / 第三方契约
    > 语言语法强制要求
    > FsusBlog C# 母规范映射
    > formatter / linter 默认值
    > 个人 IDE 设置
```

安全、隐私、AEDS 协议和发布门禁对语义的要求始终有效。它们可以要求一个外部名称、字段顺序或二进制布局保持不变，但不能无理由改变内部 adapter 的命名和普通源码格式。工具默认值与本文件冲突时必须调整工具配置或登记窄范围例外，不能反向修改规范来迁就工具。

## Repository baseline

所有手写文本源码默认遵循：

- UTF-8（无 BOM）、LF、文件末尾一个 newline、无 trailing whitespace；
- 4 spaces，禁止用 Tab 缩进；续行增加一个 4-space 层级；
- 一行一条语句、一行一个声明；同一逻辑块之间用最少必要空行分隔；
- import、include、using 先按平台/标准库、第三方、仓库内部三组排列，各组内稳定排序；
- 注释解释约束与原因，不复述代码；公开契约使用该语言的文档注释；高价值意图和性能声明见 [Code intent governance](code-intent-governance.md)；
- TODO/FIXME 只允许 `TODO(#1234): reason; removal condition: observable exit condition.`，并登记 open issue 与删除条件，禁止 owner-only 或无归属占位。

Allman braces 适用于 C# 和仓库手写 C++。TS/JS/Vue、CSS、Shell、CMake、YAML、JSON 与 Markdown 服从语言语法和社区工具可稳定表达的形式，不机械套用 Allman。

## Naming map

| C# mother rule | Cross-language mapping |
| --- | --- |
| namespace、type、public member、method、local function 使用 `PascalCase` | TS class/type/component 使用 `PascalCase`；Vue component 文件使用 `PascalCase.vue`；C++ public type 与 Shell function 使用 `PascalCase` |
| interface 使用 `I` + `PascalCase` | 仅 C# interface 强制 `I`；TS structural type 不机械添加 `I` |
| parameter/local 使用 `camelCase` | TS/JS/C++ local 与 Shell local variable 使用 `camelCase` |
| private instance field 使用 `_camelCase` | C# 强制；其他语言在不违背生态和 formatter 时使用 `camelCase` 或私有语法 |
| private static field 使用 `s_camelCase` | C# 强制；TS/JS static private field 使用语言私有语法并保留 `camelCase` |
| thread-static field 使用 `t_camelCase` | 只在支持该存储语义的语言中使用；不得把普通异步上下文变量伪装成 thread-static |
| constant 使用 `PascalCase` | C# 使用 `PascalCase`；JS/TS module constant 使用 `camelCase`，外部环境常量例外登记 |
| public contract 名称稳定且可读 | wire/ABI 名称原样保留，内部 DTO/adapter 继续使用本表规则 |
| module/file name 表达主要 owner | C# 文件与主要类型同名；TS module 用现有 `camelCase.ts`，Vue component 用 `PascalCase.vue` |

## C# and .NET

- 使用 4 spaces、Allman braces、一行一个 statement/declaration；必要的 binary expression 换行放在 operator 前。
- namespace、type、method、property、event 和 public field 使用 `PascalCase`；interface 使用 `I` 前缀。
- parameter/local 使用 `camelCase`；private/internal instance、static、thread-static field 分别使用 `_camelCase`、`s_camelCase`、`t_camelCase`；constant 使用 `PascalCase`。
- `using` 位于统一的文件级位置，`System` 组优先，随后第三方和 `FsusBlog`，组内稳定排序。
- public cross-assembly contract、协议/codec extension point、安全与 lifecycle 类型写有效 XML documentation；internal helper 不生成空洞注释。
- record、primary constructor、collection expression 和 pattern matching 仍遵守同一命名、缩进与一行一声明规则。

## TypeScript, JavaScript, and Vue

- 使用 4 spaces 和项目 ESLint/TypeScript 可稳定表达的 brace 形式；不将 C# Allman 机械应用到 JS grammar。
- component、class、type 使用 `PascalCase`；function、variable、composable 和 module export 使用 `camelCase`。
- import 依次为 runtime/platform、第三方、`@/` 或仓库内部、relative；type-only import 使用 `import type`。
- Vue SFC 保持 `<script setup>`、`<template>`、`<style>` 的现有顺序；props/emits 是 public contract，改名必须同步 caller。
- public function/type 使用 TSDoc 说明不可由类型表达的边界；普通局部逻辑不写重复注释。

## CSS

- selector 和 custom property 使用 kebab-case；4 spaces；每行一个 declaration。
- component scope、theme token 和 reduced-motion contract 优先于个人 selector 偏好。
- class/custom-property 是 DOM/CSS 外部契约时保留原名，内部 TS adapter 不复制 kebab-case 命名。

## C++

- 手写 C++23 使用 4 spaces 和 Allman braces；header include 依次为对应 header、标准库、第三方、仓库 header。
- type/public function 使用 `PascalCase`，local/parameter 使用 `camelCase`；宏和 C ABI export 只在契约要求时保留外部形式。
- Wasm export 通过窄 adapter 暴露；外部 `snake_case` 不扩散到内部实现。

## CMake

- 4 spaces；内建 command 使用 CMake 规定的名称，项目变量和 target 采用既有稳定命名。
- 一个 target 的 source/options 按职责分组并稳定排序；不要为模仿 C# brace 风格改写 CMake grammar。

## Shell

- POSIX/Bash 语法要求高于 brace 映射；4 spaces，函数和 control block 分行清晰。
- exported environment variable 使用 `UPPER_SNAKE_CASE`；仓库自有 function 使用 `PascalCase`，local variable 使用 `camelCase`；仅已登记的公共 Shell API 或环境契约保留外部名称。
- 新脚本使用 fail-closed 参数解析、引用变量展开，并给 cleanup 安装 `trap`。

## YAML

- 4 spaces、禁止 Tab；mapping key 顺序按 schema/consumer 约定稳定排列。
- GitHub Actions key、第三方 action input 和外部 schema 字段原样保留。
- 重复结构优先用仓库生成器或可读 anchor；不要用 anchor 隐藏权限和发布边界。

## JSON

- 4 spaces、标准 JSON 双引号、末项无逗号；key 顺序按 schema 和生成器稳定输出。
- API/wire 字段原样保留；内部 model 与 adapter 使用 C# 母规范映射。
- generated manifest 不手工格式化，必须修改 source 或 generator。

## Markdown

- heading 层级不跳级，fenced code block 标注语言，relative link 指向真实文件。
- 一条规范只在本文件定义；其他文档链接到具体 heading，不复制完整规则表。
- 命令示例必须可解析到现有脚本或 package script，不把伪命令写成可执行指引。

## SQL

- SQL keyword 使用大写，4 spaces，复杂 clause 分行；migration 保持可重复审阅。
- PostgreSQL column、index、constraint 与 migration identity 是外部持久契约，不能为内部 naming rule 直接重命名。
- 查询结果进入 C#/TS 后通过明确 mapping 转为内部命名。

## External contract exception registry

例外只保护外部名称。只要存在内部 adapter，内部名称仍须回到 C# 母规范映射。以下 ID 与 `config/development/authoritative-development-docs.json` 一一对应：

| Exception ID | External surface | Internal rule |
| --- | --- | --- |
| `json-api-field` | JSON/API field | wire key 原样；DTO/property/adapter 使用语言内部命名 |
| `postgres-column-migration` | PostgreSQL column、constraint、migration SQL | database identity 原样；reader/model 使用内部命名 |
| `http-header` | HTTP header | header spelling 原样；constant/accessor 使用内部命名 |
| `redis-key` | Redis key/prefix | serialized key 原样；builder method 使用内部命名 |
| `c-abi-wasm-export` | C ABI/Wasm export | export symbol 原样；C++/TS wrapper 使用内部命名 |
| `environment-variable` | process/container environment variable | `UPPER_SNAKE_CASE` 原样；options property 使用内部命名 |
| `css-selector-custom-property` | CSS class/custom property | kebab-case 原样；component token/accessor 使用内部命名 |
| `shell-environment-variable` | exported Shell environment variable | `UPPER_SNAKE_CASE` 原样；脚本内部 local 遵循 Shell 映射 |
| `cmake-built-in` | CMake built-in command/property | CMake 名称原样；项目 wrapper/说明使用内部命名 |
| `third-party-sdk-callback` | third-party callback/interface | SDK signature 原样；边界内立即适配 |

新增例外必须同时给出 external/internal 正例和“外部名泄漏到内部”的反例；不能用 `legacy` 或“formatter 不支持”作为永久理由。

## Generated, vendor, fixture, and tool exceptions

- `generated`：只改 source/generator，生成文件由 owner 命令重建；生成头和输出格式不证明手写风格先例。
- `vendor`：保留上游格式和许可证，不做仓库风格重排；修改通过 overlay/patch 层完成。
- `fixture`：可故意包含非法格式来证明门禁失败，但必须位于已分类 fixture 路径且测试说明意图。
- `lock`：包管理器拥有顺序和格式，禁止手工整理。
- `minified`：只接受可追溯 generator/source 的输出，不作为 source style 输入。

这些分类是必须显式声明的窄例外，不是忽略任意目录的通配许可。

## Imports and comments

所有语言都遵循“platform/standard → third-party → repository/local”的依赖方向；语言强制顺序（例如对应 C++ header）优先。循环依赖不能靠调整 import 顺序掩盖。

短注释放在被解释语句之前。公共 contract doc comment 说明输入、输出、失败和安全边界；TODO/FIXME 必须绑定 open issue、删除条件和 registry entry。历史叙述、release 记录、行尾注释和长篇设计理由写入 `docs/`，不堆进 hot path。结构事实与实测性能结论不得混用；具体 marker、S/M/R/C 等级和 fail-closed 条件见 [Code intent governance](code-intent-governance.md)。

## Enforcement

运行权威文档门禁：

```bash
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

门禁从 `config/development/authoritative-development-docs.json` 读取路径、symbol、command、style owner、外部例外和 generated/vendor/fixture 分类，聚合全部错误后失败。后续 formatter/linter issue 必须消费这份基线；不得创建另一份同级“唯一编码规范”。
