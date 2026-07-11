# Issue #1031 release evidence 测试交接

## 当前状态

本交接只说明 #1031 的 release evidence、bundle、持续流量与资源预算测试代码。代码已写入工作树，**尚未运行任何 test、build、lint、syntax checker 或其他验证命令**，因此不得把本文件当作生产演练证据，也不得据此宣称 #1031 已验收。

本次没有生成或提交伪造的生产证据、动态测试结果、临时目录、容器输出或构建产物。测试运行时产生的数据全部位于系统临时目录，并由 `node:test` 清理。

## 新增测试

### `tests/tools/release-rollout-evidence.test.mjs`

- `stage` 只能绑定当前正在执行的阶段，并绑定 stdout/stderr 的 SHA-256、字节数、开始时间、结束时间和退出码。
- `preseal` 只能在前 14 个阶段严格按顺序完成且 `release-evidence` 正在执行时运行。
- 缺失 artifact 与多个 artifact 的语义错误必须在同一次执行中完整返回；测试不设置最大错误数。
- `finalize` 必须封存 15 个有序阶段、六类必需 artifact 和空错误集合，并拒绝覆盖既有 final evidence。
- `verify` 必须同时检测阶段证据和六类 artifact 在 seal 之后发生的哈希或大小漂移。

### `tests/tools/release-rollout-bundle.test.mjs`

- bundle 仅收集 final evidence、15 个阶段证据、已封存 recovery evidence，以及六类命名且哈希绑定的 artifact。
- bundle index 中的每一个相对路径都必须指向实际复制文件，且 SHA-256、字节数和文件总数一致。
- evidence root 内未被 final evidence 引用的说明文件不得被复制。
- stage、recovery、artifact 的 symlink、越界路径和 seal 后漂移必须 fail-closed。
- 未识别的第七类 artifact 必须被拒绝，不能借 final JSON 注入 bundle。

### `tests/tools/release-rollout-probes.test.mjs`

- loopback HTTP server 覆盖 `home`、`archive`、`article`、`binary`、`search`、`static`、`login`、`refresh`、`protected-read`、`write`、`upload`、`admin-health` 十二类请求。
- 业务 5xx 只有同时具备 `X-Fsus-Error-Class: business`、JSON 错误码和 scenario allow-list 才能被分类为业务错误。
- 502/503/504、未标记 5xx、连接/超时错误和被中止的 in-flight 请求分别计数；部署失败不能被业务错误豁免。
- source/target release header 分布、baseline/overlap P95/P99 和影响百分比均由真实 loopback 请求计时产生。
- 120 个部署错误必须完整保留，不能尾部截断或受最大错误数限制。
- resource probe 使用临时 `docker`/`df` fake executable，不依赖真实容器状态；分别覆盖通过与 fail-closed 路径。
- 最低 CPU、内存、可用磁盘、双槽 CPU/内存、临时磁盘、OpenResty reload、drain、notification reconnect、活跃流量 P95/P99 影响均有独立断言。

## 已接线、待统一验证的强边界

静态 readback 显示下列边界已经接入 producer/verifier/bundle；它们仍必须通过统一
验证。若验证暴露失败，应修正生产实现，不应删除或放宽断言：

1. final evidence 的 `verify` 需要复核 stage evidence 的 seal-time SHA-256 与字节数，不能只复核六类 artifact。
2. recovery evidence 需要 seal-time hash/size；bundle 收集时必须检测 recovery 漂移。
3. bundle 只允许六类固定 artifact 名称，并应让 index 路径准确指向 `artifacts/<name>/<file>`。
4. traffic/resource 报告的错误集合不得使用 `.slice(...)` 或固定上限截断；可以另加摘要，但完整错误必须保留在权威 evidence 中。

## 场景覆盖与风险

- 匿名请求：主页、归档、文章、搜索、静态资源和 binary。
- 登录请求：login、refresh、protected read 与 write。
- admin 请求：admin health 与需要管理权限的发布控制面证据。
- notification stream：resource budget 强制要求 reconnect 指标；最终语义 evidence 另要求 restart、cursor replay、replay miss full resync 与慢客户端 drain。
- binary：持续流量场景将 binary 作为十二类必需请求之一，不能因文本页面成功而省略。

主要风险是证据路径被替换、阶段/恢复记录在 seal 后被修改、业务 5xx 被错误当作部署成功，以及资源 evidence 缺项时误判通过。上述测试全部采用 fail-closed 期望。

回退不要求重启：在 gateway switch 后发现 evidence 不完整或探针失败时，保持 source slot、使用持久化 rollout recovery 动作回切 gateway，并以新的单调 runtime generation 重新激活 source；不得复用失败 target 的旧 generation 或修改既有 final evidence。回切完成后重新产生独立 recovery evidence，再从对应阶段恢复。

## 中央治理 readback

三个 Node 测试文件已经登记到 `zero-downtime-release-rehearsal` coverage、现有
deployment/release evidence 逻辑 tier、`tests/matrix.yml` 与 static governance；相关
backend requirements 也已引用该 release evidence owner。行为测试使用独立临时目录和
内核分配的 loopback 端口，可并行执行，不存在遗留的中央登记动作。

在这些测试、#1031 的正常发布演练、回滚演练和中断恢复演练全部通过之前，本交接状态保持为 **code landed / unverified**。
