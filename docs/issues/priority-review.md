# 执行方案重点 issue 核对

[重点需求台账](accepted-priority.tsv)记录了九项开放 issue 的 65 条处置。逐条读过正文与全部 31 条评论，状态和更新时间以 2026-11-14 上海时间的 GitHub 读取为准。九项的 GitHub 结构化父项、子项、阻塞项和被阻塞项均为空。台账的依赖列来自正文和评论所述的责任关系与关联。正文引用的旧候选及其测试属于 v1 证据，v2 的状态记录在验收缺口列。

| 待核对的边界 | 两种处理及其影响 | 阻塞的验收 |
| --- | --- | --- |
| [#2218](https://github.com/Ozwasyd/FsusBlog/issues/2218) 明确要求 PostgreSQL、MySQL、SQLite 的真实结构准入检查。固定 v1 Server 只注册 PostgreSQL。 | v2 保持 PostgreSQL 服务准入，MySQL 和 SQLite 保持有来源证明的离线职责。对各真实输入和 PostgreSQL 目标分别执行旧结构、未知结构、转换和恢复用例。见 [C3](conflicts.md)。 | P5 全部离线来源、provider 迁移和数据保全。 |
| [#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322) 只负责定义。父项 [#1860](https://github.com/Ozwasyd/FsusBlog/issues/1860) 要求值、投影、Inspector 和迁移。 | 保留单一定义权威，独立实现并连接 [#2323](https://github.com/Ozwasyd/FsusBlog/issues/2323) 值、[#2324](https://github.com/Ozwasyd/FsusBlog/issues/2324) 检索、[#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325) Inspector、[#2326](https://github.com/Ozwasyd/FsusBlog/issues/2326) 迁移；#2327 负责端到端验收。引用的环、自引用和归档策略以及 URL scheme、相对路径等规则须在定义、值和查询间统一。 | P4 真实属性交互及 P5 旧数据迁移。 |
| [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738) 的真实转换同时依赖 [#3735](https://github.com/Ozwasyd/FsusBlog/issues/3735) 传输与 [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736) 界面。 | 基于稳定授权和修订提交 HTTP/AEDS、数据库事务和界面。历史候选通过的原始数据库测试覆盖该候选的部分事务行为。v2 同一候选需补齐全部运行证据。 | P4 Canvas 闭环，协议向量与实际 Provider。 |
| [#2295](https://github.com/Ozwasyd/FsusBlog/issues/2295) 的局部责任边界与完整恢复能力不同；[#4234](https://github.com/Ozwasyd/FsusBlog/issues/4234) 的绝对期限由服务端执行。 | 标签、关闭保护、分组和恢复共享 Registry；确认 #1854、#1855、#2233 和 #2235 对应条款。服务端按绝对期限、空闲期限和撤销验证。浏览器用生命周期代次拒绝晚到结果。 | P4 跨组导航、恢复及真实权限撤销。 |
| [#4537](https://github.com/Ozwasyd/FsusBlog/issues/4537) 的焦点回归与 [#4750](https://github.com/Ozwasyd/FsusBlog/issues/4750) 的完整类型和多个消费者渲染各有验收。 | 浏览器覆盖不同宿主销毁/重建和真实 Drawer 时序，完整类型程序使用真实 FsusUI checkout。历史 16 个 helper 声明和旧 patch 属于 v1；v2 验证自己的实际声明和消费者。 | P3/P4 受影响界面的真实主题、键盘、焦点与跨断点行为。 |
| [#3665](https://github.com/Ozwasyd/FsusBlog/issues/3665) 的范围限定了 IO broker 加固，父项 [#2142](https://github.com/Ozwasyd/FsusBlog/issues/2142) 涉及生产授权和宿主。 | 保留封闭 proposal、授权复核和所有权清理。production consent/grant 持久化、ArticleQuery 和其他保留 RPC 需要与父项及真实 host provider 核对后实施。 | P5 插件端到端和 native 隔离。 |
| [#1950](https://github.com/Ozwasyd/FsusBlog/issues/1950) 使用历史仓库的运行时限。其评论指出总时限与各阶段之和存在不一致。 | 冻结 v2 的负载、数据集、业务断言和分段时限，记录 setup、测量和清理实际耗时；直连与反代/TLS 分开测。单机公开读取 10,000 QPS 为待验目标。 | P2 复估、P6 完整吞吐与清理。 |

`R-1950-01` 至 `R-1950-05` 的后续证据包括固定工作负载、两套独立数据库及运行 ID、按路由和按秒的业务核对，以及正常和两次准备失败后的清理。短档的最高请求档位仍超过 0.1% 漏发加错误上限，默认 GC 长测的 RSS 峰值超过 1.5 GiB。原 #1950 的 #3734 是历史源码交付。跨运行准入、运行中断与重复恢复负控及最终规模验收须保留独立结论。 [冻结工作负载](../product/p2-acceptance.md) · [容量矩阵](../../tests/Performance/matrix-2026-11-15.md) · [默认 GC 长测](../../tests/Performance/default-gc-soak-2026-11-15.md) · [#1950 的源码交接](https://github.com/Ozwasyd/FsusBlog/issues/1950#issuecomment-6876907923)

`R-2322` 的定义与版本边界继续由定义权威验收。当前八属性类型、四条件保存视图和固定、默认、排序属于实际已实现的范围。#2324 另外要求同一作者索引和查询器处理 eligibility、权限、空值、稳定选项 ID、分面和排序。#2346 的条件执行及 #2351 的旧源移除各有验收，见冻结行号和当前入口。 [现行属性](../product/properties.md) · [现行保存视图](../product/author-saved-views.md) · [显式引用台账](text-reference-review.md) · [语义核对](semantic-scope-review.md)

其余开放 issue 查阅和处置另见全量盘点。重点台账的覆盖范围是上述九项的来源和验收映射。
