# Backend security Roslyn source policy

`security/backend-source-policy.json` 是 #1037 唯一的源码形状治理入口。实现位于
`tools/security/FsusBlog.SecuritySourceAnalyzer`，使用 Roslyn syntax tree 报告文件、行、列和
稳定 rule ID；它不以 `Contains`/`DoesNotContain` 包装生产源码。

当前规则拒绝安全目录中的 `Random.Shared` 与 `new Random`、敏感值的普通忽略大小写比较、
raw sensitive structured-log placeholder、非日志输出中的 raw exception detail，并校验
Argon2 memory/iteration 与 recovery-key PBKDF2 最低值。policy 的 include scope 是允许列表，
不得自动扩大到 generated、fixture 或无关业务目录。

`tests/backend/Fixtures/security-source-analysis/positive.cs` 必须零诊断；`negative.cs` 必须同时
触发 `FSUSBLOGSEC001` 至 `FSUSBLOGSEC008`。Node harness 先分析仓库，再以相同已构建 analyzer
分析两个 fixture，并要求所有 fixture 诊断只来自 negative 文件。

中央合并时应把 `node --test tests/tools/security-source-analyzer.test.mjs` 接入
`static-governance`，并在 coverage registry 中以一个独占 coverage ID 绑定 policy、analyzer、
fixtures、harness 和 #1037 evidence。禁止添加最大错误数；一次运行必须保留全部诊断。

本文件不表示 analyzer 已运行。当前验证状态为 `not-run-by-instruction`。

