# 执行状态

执行依据为原始 `FsusBlog-v2-net10-execution-plan.md` 和用户确认的本地 FsusUI alias。这里是检查点，不是验收报告。

| 阶段 | 已产出 | 尚未达到的退出条件 |
| --- | --- | --- |
| P0 | 固定 v1 源；[开放 issue 源快照和台账](issues/)覆盖 808 个议题和 2,562 条冻结评论。完成[界面与功能](product/)、[代码量](baseline-source.md)和[依赖基线](baseline-dependencies.md)，逐项核对 17 个 FsusUI 关联、115 条高风险条款和 712 条历史评论来源。 | 同仓自由文本引用的语义、剩余契约冲突和完整测试映射待核对。 |
| P1 | .NET 模块化单体、当前 schema 独立工具、真实 FsusUI 本地类型与运行入口、AEDS 生成及跨语言测试。SDK 10.0.404 和本机运行库 10.0.15 已验证。 | 生产配置、通用 PoW 风险、完整账户恢复、管理员权限矩阵待完成。 |
| P2 | PostgreSQL 与 Chrome 跑通登录、保存、CAS 冲突、发布、公开 HTML/AEDS、Worker 全文索引、撤回和注销。真实数据库故障验证写入回滚、发布投影恢复与重启旧代失效。原生 [256 请求冷读](../tests/Performance/cold-2026-11-14.md)全部正确。浏览器已验证顺序短语与 Unicode 归一化。 | v1 词典、精确词元规则与分片补丁，以及正式直连、代理/TLS 和长时性能仍待完成。 |
| P3 | 工单读写、已读及私有通知重连，SEO/合规、标准 Feed、相关文章、评论树和 PoW 投稿已原生验证。写工单采用部署开关和动作绑定 PoW。独立管理员离线引导和 Passkey 登录、站点账号 MFA/会话撤销、私有 PNG/JPEG 资产库均有真实浏览器和实库验证。 | 管理域实际 HTTPS 入口、完整权限、v1 评论风险/匿名/审核、分片及附件票据、页面管理、订阅、工单的管理和广播仍待完成。 |
| P4 | 多标签通过单一 registry 管理会话。真实 Chrome 验证跨断点 Inspector、属性和私有历史恢复新草稿。草稿恢复、Canvas 图及受限边转换、文章发布沿革已按事务验证。 | 完整工作区与崩溃恢复、跨标签 undo、公开历史及 Rights V3、属性查询、Canvas 图形界面与 undo/redo 仍待完成。 |
| P5 | 真实 PostgreSQL 完成 schema 初始化和备份恢复。旧库只读 intake 和含发布谱系、分类与权利的影子转换在 [PostgreSQL、SQLite 和 MySQL](migration-source.md) 样本上实测。扩展持久安装、激活与隔离有实际离线 CLI 测试。 | 生产旧库盘点、完整数据转换和激活、插件运行时、主题与字体、导出、集群和生产诊断仍待交付。 |
| P6 | 未进入 | 全功能验收、性能和全量减量复算未做。Docker 测试由外部环境承担，本机未运行。 |

单进程公开快照受 PostgreSQL 独占租约保护。撤回、删除或发布进入提交时使当前快照不可用，提交后根据已提交修订刷新。AEDS、HTML 和分片搜索索引来自同一公开代次。租约失效后服务停止提供快照和接收事务。备用进程在同一 PostgreSQL 主库上等待旧事务退出并重建快照。[单机数据库租约与交接](publication-lease.md)

90% 是全部功能交付之后的目标。现有切片的比值不能说明已达到该目标。

代码量检查点 `0e204f8` 有 234 个入选文件和 37,391 规范化 NCLOC。固定 v1 主口径为 2,085,464，v2 上限为 208,546。Go 压测代码和 Caddy 配置已计入，固定 v1 样本不含这两类路径。按 v1 剩余能力和采用的 issue 分配了 [各域剩余预算](product/code-budget-checkpoint.md)，完整功能的实际减量仍待复算。

`3625a2c` 独立检出通过 11 项 Core、22 项集成测试、AEDS C#/TS/C++/Wasm、严格前端类型及构建和 Chrome 发布闭环。后续候选继续追加实库与浏览器证据。两轮直连最高档分别完成约 10,471 和 10,422 个正确响应每秒，客户端漏发分别为 0.273% 和 0.747%，均超过 0.1% 上限。见[直连诊断](../tests/Performance/diagnostic-2026-11-14.md)。

`2bc654d` 的独立检出在 SDK 10.0.404、PostgreSQL 18.7 上通过 Release 编译和全部 28 项原生集成测试。Caddy TLS 经实际证书、来源和 Cookie 验证。两轮代理最高档错误与漏发共 0.540% 和 0.141%，均高于约定的 0.1%。见[代理诊断](../tests/Performance/proxy-2026-11-14.md)。

干净的 `8e84f89` 生成发布候选，247 个解包文件通过摘要校验，bundle 已导入独立裸仓库并通过 `git fsck --full`。候选证据在本机 `artifacts/candidate-release-verified/`。

`0de9f1c` 的独立检出以锁定依赖通过 Release 编译、31 项 Core、74 项原生 PostgreSQL 集成和 40 项 Node 协议检查。独立向量通过 C#、C++、Wasm，JS/Wasm 差分覆盖 2,821 个确定输入。该候选发布包内 279 个文件均通过摘要校验，并从解包后的服务、静态文件和迁移工具跑通真实 Chrome 业务流。Git bundle 导入空仓库后通过 `git fsck --full`。该轮证据位于 `artifacts/candidate-0de9f1c/`。

两轮 15 分钟诊断归因四条热读零 PostgreSQL 命令及物理连接。默认 GC 的 RSS 峰值 1,645,200 KiB，超过 1.5 GiB。`ConserveMemory=5` 峰值为 1,513,568 KiB，达到该轮 RSS 预算，两种 GC 时间口径的差异及初始同机并发仍已记录。正式容量验收未通过，生产默认 GC 配置未改。见[运行时诊断](../tests/Performance/runtime-2026-11-14.md)。

`7051094` 后续快照生成的发布候选，274 个解包文件通过摘要检查，Git 历史可导入并通过 `git fsck`。同一提交的 TLS 预连接诊断完成 256 次握手并返回 300/300 正确响应。证据分别位于 `artifacts/release-7051094/` 和 `artifacts/proxy-preconnect-smoke-7051094/`。
