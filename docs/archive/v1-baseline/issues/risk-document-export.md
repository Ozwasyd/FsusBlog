# 文档导出：采用条款与未完成合同

范围为 review-2221-2450.tsv 的六条已有采用记录，不新增或删去功能。来源只读自 2026-11-14 冻结的 open-issues.ndjson.gz；L 是对应正文的行号。实现与用例定位 386066d，运行证据仍分别绑定其原候选，不能据此宣布当前提交完整通过。以下替代早期审阅表中“任务队列尚未实现”的进度判断，不抹去历史失败或放宽条款。

## V2S-2412

**冻结 L10–24：唯一任务、明确输入、幂等、取消、终态、attempt 与留存。**

- 实现：[DocumentExportStore](../../src/Server/Authoring/DocumentExportStore.cs)、[DocumentExportInput](../../src/Server/Authoring/DocumentExportEndpoints.cs)、[DocumentExportWorker](../../src/Server/Authoring/DocumentExportWorker.cs)。复用已保存修订及媒体 authority，不另存一份可编辑正文。
- 对应场景：DocumentTasksFreezeSavedSourceAndProtectDurableDownloads 在任务等待期间继续保存，核原修订、同 ID 重放、异格式冲突、重启同字节；WorkerRefusesSavedMetadataDriftAndRestartKeepsTheFailedAttempt 核输入漂移拒绝和旧失败保留。[实库用例](../../tests/Integration/DocumentExportPostgresTests.cs) · [35 项定向运行](../../artifacts/goal-followup-76bb581/lanes/document-receipt-native.log)
- 未完成：完整 draft/publication 坐标，property、rights、responsibility、locale/layout 快照；admitted/blocked/cleanup 状态及关联 attempt 历史。一个新任务 ID 成功不能替代同一任务的完整 attempt 契约。

## V2S-2422

**冻结 L10–26：私有产物、每次授权、grant、摘要、配额及精确回收。**

- 实现复用上述 Store 的 Download、Owned 与 Worker；当前结果保存在私有 PostgreSQL bytea，不在公开静态目录。下载使用当前会话和显式任务 ID，检查 owner/generation/expiry、成功状态、长度及 SHA-256。
- 同一 DocumentTasksFreezeSavedSourceAndProtectDurableDownloads 核匿名、其他作者、只读账号、已撤销会话、取消和过期拒绝；实际篡改产物返回不可用，重启后查询确认精确过期行已移除。响应检查复用 [ExportResponseFixture](../../tests/Integration/ExportResponseFixture.cs)。[已执行日志](../../artifacts/goal-followup-76bb581/lanes/document-receipt-native.log)
- 未完成：独立短期、purpose/output-bound opaque grant；完整 Range/HEAD 和下载/回收并发、清理失败 obligation、字节配额。现有每作者 4 项、站点 16 项、30 分钟仅为小配额，不是 L23 的 1,000 任务、大文件 streaming 或回收吞吐验收。

## V2S-2423

**冻结 L10–24：冻结合同、四格式 provider、feature support、重现性和旧合同失效。**

- AQueuedLegacyProviderRendersItsOriginalProfileBesideCurrentTasks 核旧 provider 原产物与当前任务并存；WordReceiptReportsTheSavedSourcesLiteralFormattingWithoutChangingOutput 核 Word warning、位置和产物不变；EPUB warnings 由保存源派生。[实际用例](../../tests/Integration/DocumentExportPostgresTests.cs) · [Word 8 项运行](../../artifacts/goal-next-14355d2/lanes/word-warnings/native-warning-verified.log) · [EPUB 13 项运行](../../artifacts/goal-next-f7d8255/lanes/epub-warnings/native-warning.log)
- PDF 工具摘要和产物回执有真实工具运行；下载前复验仍由 Store 负责，typed/source-generated [DocumentExportReceipt](../../src/Server/Authoring/DocumentExportReceipt.cs) 只编码回执，不取得授权职责。[实际 PDF 与回执日志](../../artifacts/goal-followup-76bb581/lanes/document-receipt-native.log)
- 未完成：完整语法 feature-support matrix、全部 frozen metadata、normalized semantic digest 及 closed invocation/resource declarations。字节一致样本不能代替规范化语义摘要。L22 要求合同变化后的失效，兼容旧版仅证明原合同仍有效时的存量处理，不能宣称此裁决完成。

## V2S-2424

**冻结 L10–27：紧凑任务 UI、来源选择、服务端任务、warning、重开和可访问性。**

- [DocumentExportTasks](../../src/Web/src/authoring/DocumentExportTasks.vue) 和 [真实浏览器流程](../../tests/EndToEnd/document-export-task-flow.mjs) 使用服务端任务入口。375px 实测 HTML/PDF 创建、重载与下载；后续桌面/375px 实测私有图片、按序选择、任务回执及键盘交互。[初始窄屏结果](../../artifacts/document-export-tasks-13bf4fc/browser/browser-result.json) · [图片和回执结果](../../artifacts/goal-followup-76bb581/lanes/document-receipt-chrome.json)
- 未完成：完整键盘、屏幕阅读器、焦点、主题与缩放矩阵，publication 坐标、所有 closed options 与 new-attempt UI。已测部分键盘动作不等于完整无障碍。现有限额不证明 L22 的千任务分页/虚拟化、DOM/listener/poll 预算。

## V2S-2425

**冻结 L10–24：唯一 sandbox、固定工具、预算、取消、实际退出和原失败。**

- [PdfDocumentExport](../../src/Server/Authoring/PdfDocumentExport.cs) 和 [pdf-render.py](../../src/Server/Authoring/pdf-render.py) 使用固定工具及隔离资源。真实 PDF 的取消、租约丢失和正常运行收到 SIGTERM 均有进程回收及重启证据。[实际用例](../../tests/Integration/DocumentExportPdfPostgresTests.cs) · [3 项通过日志](../../artifacts/document-export-sigterm-2ec1b97/graceful-and-cancellation.log)
- 首次暂停子进程的 SIGTERM 实验未通过，保留[首次日志](../../artifacts/document-export-pdf-749b9ba/restart-2.log)。后来正常运行样本成功不擦除该失败，也不等同所有停机时序通过。
- 未完成：全格式统一 plan/actual/attempt execution envelope，全部资源、进程树逃逸、清理失败和跨平台同用例矩阵。现有 macOS/独立 Linux 的局部结果不互相冒充。

## V2S-2434

**冻结 L10–24：唯一 output/download/retention authority、grant、原子提交及恢复。**

与 V2S-2422 合并采用同一 Store、Worker 和授权测试，不为重复来源建立第二存储或回收实现。上述真实摘要、越权、到期、撤销和重启测试是共同证据。

仍需独立 purpose/output-bound grant、用户显式删除及 logout/site-switch 完整处置、active-download/cleanup 并发与清理失败恢复。私有数据库结果和会话校验不等同这组完整 grant/storage 合同；尚无独立 staging→正式存储原子交付矩阵或千任务规模证明。

## 本轮追溯检查

六条原 requirementId、来源、时间、OPEN 状态、处置、模块和依赖不变，只把通用验收模板改为具体场景、证据位置及剩余合同。已登记不等于已实现，局部通过不等于整个 issue 通过。P0 的完整原子裁断和其他采用条款仍未完成；V1 退役不删除上述 V2 导出需求。
