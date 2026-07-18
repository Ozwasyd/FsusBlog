# Code intent governance

代码风格的唯一权威仍是 [Coding conventions](coding-conventions.md)。本文件只说明如何把无法从语法直接推导的约束、公共契约和性能证据登记为机器可验证的代码意图，不建立第二套风格规范。

## When comments are required

普通 internal helper 不要求注释。只有删除注释会让维护者无法判断以下边界时才保留短注释，并把它放在被解释语句之前：

- pooled buffer、lease、dispose 和 callback 的 ownership/lifetime；
- sensitive bytes 的清零时机；
- unsafe、ABI、wire layout、兼容性标识和 copy/no-copy 边界；
- concurrency、backpressure、fail-open/fail-closed 与 deliberate lock/validation/branch；
- cache hit/miss/cold/warm 的边界；
- workaround 的退出条件、benchmark comparison path 和故意不优化的 non-goal。

优先使用以下可搜索 marker：

| Marker | Meaning |
|---|---|
| `OWNERSHIP:` | 谁持有资源、何时转移、何时释放 |
| `SECURITY-INVARIANT:` | 不可放宽的清零、校验或失败策略 |
| `PERF-INVARIANT:` | 可由源码证明且受证据保护的结构边界 |
| `COMPATIBILITY:` | 外部 wire/ABI/storage identity 必须保持的原因 |
| `MEASUREMENT:` | 结论属于哪个 producer、policy 和机器证据 |
| `NON-GOAL:` | 本次改动明确不声称改善的路径 |

marker 不是装饰。`tests/governance/code-intent-registry.json` 必须把高价值 marker 绑定到现存 source path 和 symbol；实现删除或重命名后，旧引用会使门禁失败。

## Prohibited comment debt

源码注释不得：

- 复述下一条 return、赋值或自增语句；
- 在语句尾部追加说明；
- 记录修改日期、修复历史、版本毕业叙述或发布日期；
- 把长设计历史留在 `/* ... */` 中；
- 使用“零分配”“纳秒级”“物理极限”等没有证据边界的绝对性能声明；
- 添加未绑定 open issue 和删除条件的 TODO/FIXME。

历史与设计理由写入 `docs/`，源码只保留当前仍成立的约束。公共 API 使用语言原生结构化文档：C# XML documentation、TS/JS TSDoc、Vue props/emits 上的 TSDoc、C++ Doxygen；Shell/CMake public entrypoint 使用相邻的 `Contract/Input/Output/Failure` 字段。文档必须说明类型系统不能表达的输入、输出、失败、borrow/lifetime 或安全边界。

## TODO lifecycle

允许的格式只有：

```text
TODO(#1234): incomplete reason; removal condition: observable exit condition.
```

对应 registry entry 必须包含 path、issue number、`state: open`、最近一次 live GitHub 核验时间和同一 removal condition。checker 校验源码与 registry 双向存在、核验时间未过期，并在存在 TODO 时通过 GitHub 读取 issue 当前状态；无法读取、issue 不存在或不再 open 都 fail closed。issue 关闭、实现落地或退出条件满足时，TODO 与 registry entry 必须在同一变更删除。

## Performance claim levels

| Level | Allowed conclusion | Required authority |
|---|---|---|
| `S` structural | source-visible copy、allocation、lookup、branch 或 lifetime 结构事实 | source path、intent marker、明确 structural boundary；永远不能升级为“实测更快” |
| `M` local measured | 同机同 runtime 的 before/after allocation、mean、p50、p95 | current commit、Release artifact digest、CPU/OS/runtime identity、raw rounds、iterations、noise policy |
| `R` route measured | 某 route/protocol/status/cache/error-frame 组合的运行时结果 | `M` 全部条件，加完整 route dimensions 与同源 runtime evidence |
| `C` capacity measured | saturation、capacity 或 hardware-counter 结论 | `R` 全部条件，加隔离的 target/load generator、饱和阶段和真实 counter authority |

stale/wrong SHA、artifact bytes 不匹配、机器 identity 缺失或统计字段不完整时，`M/R/C` 只能得到 `blocked`；`S` 无论收到多少测量字段都保持 `structural-only`。绝对性能数字不能从结构事实外推，cache-miss 结果不能外推为 cache-hit QPS，application copy reduction 不能外推为 Redis/socket/filesystem zero-copy。

源码注释和 registry 只声明证明边界，不能替代 benchmark、test、validator 或其原始产物。没有对应执行证据时，即使文字描述正确，也不得把 claim 升级为 measured。

## Registry and checker

`tests/governance/code-intent-registry.json` 是唯一 machine-readable registry。它包含：

- comment scan roots、语言扩展和复用的 generated/vendor/fixture/lock/minified 分类；
- README、architecture overview 等 public entry document 的无边界性能措辞门禁；
- `trackedTodos[]`、`publicContracts[]` 和 `intents[]`；
- `S/M/R/C` 的要求；
- measured intent 的 producer、policy anchor、evidence paths、required statistics 和 non-goals。

registry 中的 `M/R/C` 只登记 `measurement-contract`，不把历史文档静态标为本次 `measured`；只有绑定 current commit 的 receipt 通过 authority 校验才能升级。日期/历史、TODO/FIXME 与无边界绝对性能词执行全仓高置信扫描；行尾、复述和长 block 规则只作用于已登记 intent/public contract surface，避免把协议 literal、语言惯例或未审阅路径机械改写。这个作用域由语义 registry 正向声明，不是按当前错误生成的 baseline。

registry 不接受 baseline、最大错误数或宽泛 exception。checker 通过 Git tracked + nonignored 文件枚举，只排除权威文档已经定义的生成物、vendor、fixture、lock 和 minified 分类；它聚合全部错误，不在第一条错误后停止。字符串、URL、SQL literal 与 shell expression 不作为注释扫描。

运行聚焦门禁：

```bash
node tools/governance/check-code-intent.mjs
node --test tests/tools/issue-1155-code-intent.test.mjs
```

`static-governance` 同时执行 checker 和 fixture contract。回退 checker 本身不能改变 runtime 语义；若规则误报，应修正 tokenizer 或收窄语义分类并补正反 fixture，不能添加现状 baseline 来隐藏真实债务。
