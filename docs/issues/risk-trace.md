# 首批风险条款与文本依赖回查

以评论冻结提交 `92e6464` 为输入，以实际功能提交和对照时的工作树核验。表格中的开发中代码明确标记为未提交。旧候选的成功记录只说明原实现和场景曾被验证。本次核对未重跑负载或集成测试。

| 条款范围 | 回查结果 |
| --- | --- |
| 离线迁移 | 将 #1760、#1761 和 #1762 评论里的顺序图拆成独立的结构准入、plan、apply、verify、文章与本地媒体互证。#567、#2173、#2211–#2213 的已关闭状态和正文已单独核对。#2699 已删除，其余保留要求据 #2223 追踪。现有 v2 原生样本、空库恢复、现行 PostgreSQL 验证和旧库只读盘点都有明确范围。生产 legacy apply、真实 DB 与媒体切换、持久检查点和独立恢复仍待验收。 [迁移条款](risk-migration.tsv) |
| 附件、上传与代理 | #1778、#1781、#1782、#1783 的关闭状态已独立核对。#3585 和 #3559 是已合并的 v1 PR，分别提供代理拓扑和编译证据的历史线索。`97d9787` 的作者专用媒体库已有实际 PostgreSQL 和 Chrome 证据，涵盖限量 PNG/JPEG 上传及同作者会话下载。v1 附件票据、分片/续传、内容引用和清理、真实代理字节计费仍分别追踪。#2076 与固定 v1 票据的失败状态和一次消费仍按 C9 待定。 [附件条款](risk-assets.tsv) · [当前媒体验证](../product/private-media.md) · [固定票据](https://github.com/Ozwasyd/FsusBlog/issues/1782) · [代理拓扑 PR](https://github.com/Ozwasyd/FsusBlog/pull/3585) · [编译证据 PR](https://github.com/Ozwasyd/FsusBlog/pull/3559) |
| PoW 与权限 | 固定 v1 的 AEDS challenge、classic proof、风险 aggregate、强匿名、WebAuthn 和 MFA 分属不同边界。`561de55` 接通评论专用 AEDS challenge、classic PoW、Worker、本地速率/难度策略，以及证明一次消费与提交待审的实际 PostgreSQL 事务。v1 风险 aggregate、通用 use-case 路径仍待验收。后续 `d84c22d` 验证登录账号工单创建/回复的生产 AEDS 通路及专用证明，`08e1ee8` 与 `6d60f51` 补私有唤醒及重连。固定 v1 公共/管理员通知和自适应风险仍分开验收。作者、管理员、上传、账号注册和恢复分别按固定路由核对。 [PoW 条款](risk-pow.tsv) |
| 属性、扩展和 Canvas | 八种属性的 CRUD 有实际持久化与 AEDS，尚未完成草稿、历史修订、发布属性快照以及索引。签名扩展尚缺真实属性 validator 宿主、撤销与执行接线。Canvas 受限边型真正进入服务端数据库事务，已有隔离的 Kestrel/PostgreSQL 结果。完整 Canvas 界面、标题与块引用、撤销和 v1 协议互操作仍未验收。 [创作条款](risk-scope.tsv) |
| FsusUI 跨仓依赖 | 规则提取的 17 个编号均经独立 GitHub GET 确认是已关闭 issue。固定 FsusUI 检出中的真实公开 API 与对应测试逐项定位，再检查 v2 当前入口有没有消费。#416 npm 发布自动化按本次 checkout alias 要求归旧工程。Live、命令、附件、大纲以及特殊 Markdown 在编辑和公开显示的语义仍各自验收。 [跨仓依赖](dependency-fsusui.tsv) |

3,516 条规则提取的候选共指向 771 个不同目标。2,615 条可关联冻结清单里的 560 个同仓开放 issue。795 条指向清单以外的 194 个同仓编号，可能是已关闭来源、PR 或已删除记录。其余 106 条为 FsusUI 的 17 个编号。该统计用于安排复核。评论中的提及、历史 PR 交接与明确的前置要求仍按各条来源判断。高风险样本共 72 条，另逐项核对了 17 个 FsusUI 目标。尚未逐条解释全部文本候选或覆盖正文中的所有自由表达。

## 进程资源归属、首因和清理

以下核对 #3524 正文 L36–65、三条冻结评论及 #3527/#3620。签名 worker 的实测候选是 `5122929abfa7605f54bd0178f679ea7eccee0e7f`。五个变动文件的 Git blob 与落地主线 `65bab124675fed4868e356373e9b6d3888f01fb0` 一致，Debian 校验了同一份 macOS 构建的 Migrate DLL。 [原始验证和传输记录](../../artifacts/plugin-worker-completion/verification.txt) · [冻结议题](https://github.com/Ozwasyd/FsusBlog/issues/3524) · [三条评论处置](comments-late-provider.tsv)

| 条款 | 实际证据和剩余范围 |
| --- | --- |
| #3524 L36–65、评论 5848866039 L1、5995726380 L7–17 | 原失配候选的资源预约函数仅有测试调用。固定 v1 的规范执行源随后已在创建前申请配额，绑定 source/run/namespace/bundle/step，从同一所有权记录独立观测实例和凭据缺失后释放。评论的 82 项使用受控适配器。v2 已有原生 MySQL 私有 socket、真实 `@@skip_networking`/数据目录和同一进程停止检查，以及独立迁移夹具证据。规范执行入口仍需将实际 Migration assembly、测试发现、独立 TRX、资源预留和现行真实 MySQL 实例绑定到同一次运行，并复验完整回收名单、凭据消失和释放顺序。 [旧预约失配](https://github.com/Ozwasyd/FsusBlog/issues/3524#issuecomment-5848866039) · [恢复约束](https://github.com/Ozwasyd/FsusBlog/issues/3524#issuecomment-5995726380) · [固定 v1 caller](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tools/test-matrix/scheduler.mjs#L6140-L6209) · [v2 MySQL 夹具](../../tests/Integration/Migration/mysql-scratch.sh#L21) · [实际迁移范围](risk-migration.tsv) |
| #3527 L27–34、#3620 L8–12 | Linux ARM64 签名 worker 以独立临时 unit 启动。在交给 worker 输入前，读回真实 `MainPID`、进程的 `/proc` cgroup、`cgroup.procs`、128 MiB、零交换、24 个任务及单 CPU 配额。原生隔离用例在期限或父进程被终止前持有观测到的成员 pidfd，独立验证原进程和 cgroup 清空，并在结束比较 unit。动态扩大／收缩、并行 grant、独立嵌套 service、通用进程观测的健康 proc-root／boot 与 PID 重利用例仍缺验收。48 MiB／8 个任务／25% CPU 的实测为独立静态探针，只证明该探针负载。 [#3527](https://github.com/Ozwasyd/FsusBlog/issues/3527) · [#3620](https://github.com/Ozwasyd/FsusBlog/issues/3620) · [worker 准入与控制文件读回](../../src/Migrate/LinuxPluginRunner.cs#L100) · [实际期限夹具](../../tests/Integration/Migration/linux-managed-plugin-flow.py#L115) · [静态探针记录](../../artifacts/linux-plugin-cgroups/native.log) |
| #3524 评论 5996350570 L3–6、L11–19 | 旧 scheduler 验收要求保留 JS 原拒绝值，包括 `0`、`undefined`，finalizer 按逆序执行一次、清理失败保持所有权未完成。旧 31 项为受控测试。v2 Core 的六个受控完成用例证明先分类的 C# 工作错误、调用方取消或期限可保留为首因，清理仅产生附加失败；按调用者提供的顺序继续尝试各释放步骤，单独的清理失败抑制发布。CLI 使用稳定错误码及可选的 `cleanup=plugin-worker-drain`，调用方取消保持 130。完整 Core 133 项通过。未留存同时触发两个原生错误、控制器所有权状态转换失败或并发 worker 的结果。 [冻结首因](https://github.com/Ozwasyd/FsusBlog/issues/3524#issuecomment-5996350570) · [释放代码](../../src/Core/Extensions/PluginWorkerCompletion.cs#L8) · [CLI 结果](../../src/Migrate/PlatformPluginCommand.cs#L59) · [受控首因用例](../../tests/Core/PluginWorkerCompletionTests.cs#L8) · [Core 结果](../../artifacts/plugin-worker-completion/core.log) |

macOS 签名运行通过在途审批变更与暂停工作进程的回收。Debian 13 ARM64 的实际签名流程通过 12 项，校验了 206 个安装文件。首次 Debian 记录为 `exit=0, cleanup=no`。对应工作进程、unit、cgroup 和正式安装已验证消失，测试暂存树的 0555 目录无法由原清理账号移除。同一隔离虚机在复核本次目录后单独补清，复验安装、unit、cgroup、暂存路径均已移除，虚机已停止。首份清理失败和后续结果分别保留。 [macOS 日志](../../artifacts/plugin-worker-completion/macos-native.log) · [Debian worker 日志](../../artifacts/plugin-worker-completion/debian-native.log) · [首次状态](../../artifacts/plugin-worker-completion/debian-exit-status) · [补清记录](../../artifacts/plugin-worker-completion/debian-cleanup-retry.log)
