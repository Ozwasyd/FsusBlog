# Issues #1033–#1035：治理测试与阻塞 tier 收口

## #1033：删除纯元测试

八个 xUnit 文件已从 active inventory 删除。文档措辞、其他测试方法名、workflow/YAML
文本和固定超时不再伪装成产品行为测试。仍需保留的 matrix、workflow、requirement、coverage
和文档规则由结构化 checker 所有；30 个 baseline test ID 已登记到中央 replacement manifest。

## #1034：退出不可证明的 viewport parity

`ux-viewport-canary-parity`、runner、lane、Node 测试与 legacy fixture 已离开 active DAG 和
inventory。replacement manifest 明确把 production membership/coverage/artifact 交给当前
plan-progress、smoke、boundaries、visual 与 summary，不声称不存在的历史 parity 已被证明。
只允许统一验证后的 wall-clock 数据描述收益，tier budget 不是实测节省。

## #1035：统一历史残留与 fixture secret owner

通知流退役分组、前端退役 export/API 和 legacy fixture secret 由统一 static checker 所有；
SQL fixture 在扫描范围内，fixture harness 同时包含命中与安全样本。三个重复的 xUnit/Vitest
包装已删除，7 个 baseline ID 已登记到中央 replacement manifest。checker 报告稳定 rule、
path、line 与可定位消息；allowlist 必须显式且最小。

## 验证状态

三项实现已在 local master 的独立 commit 中落地；当前统一代码落地阶段没有重新运行测试、
构建、lint、syntax check、matrix、retention、coverage、mutation 或 production fresh。最终状态
仍取决于统一验证阶段的 after audit 和 77-tier production evidence。
