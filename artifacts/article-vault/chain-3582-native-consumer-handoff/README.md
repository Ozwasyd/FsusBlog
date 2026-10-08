# 实际 native consumer 接入与原始门禁

已按交接消费 canonical `b74df8814da2a8ff6455ec2b5f1d97956183040c`，当前实现提交为 `69b340d6f9063a60c67c95eeabbea24b9ed62a54`。12 个交接文件逐字节一致，完整原始 source/history 保留。该实现已推送到 `codex/chain-3582-current-acceptance-20261008`，草稿 [PR #3900](https://github.com/Ozwasyd/FsusBlog/pull/3900)。后续 `3e9c6dbfa` 仅更新当前架构说明，`65b3904551d2a7fbc5e2c08e3e52f62dcda40cec` 仅补齐 root 现有普通命名 aggregate 的 5 个精确 source paths。

## 本轮实际执行

|项目|绑定候选|结果|
|---|---|---|
|原始观察项目 Release/locked restore 全部测试|69b340d6|69 执行：62 通过、7 失败、0 跳过；exit 1|
|#3582、#3558 与 accepted-source/recovery/instruction/checkpoint 后端控制|69b340d6|187 通过、0 失败、0 跳过；exit 0|
|原 compiled metadata inspector 控制，使用同轮真实 backend DLL|69b340d6|18 通过、0 失败、0 跳过；exit 0|
|11 个交接 C# 文件样式|69b340d6|0 违规；exit 0|
|原 scanner positive/refusal 与 convergence 单元套件|65b390455|17 通过、0 失败、0 跳过；exit 0|
|原 scanner 实际检查 root/export owner test 文件与正反 fixtures|65b390455|两个 owner 均 0 findings，原 negative rules 保留；exit 0|
|#3582 自有 owner C# 文件样式|65b390455|0 违规；exit 0|
|原 repository change contract|69b340d6|exit 0|
|原 matrix / convergence|3e9c6dbfa|各 exit 1，原 finite authority 与两个 replacement 声明仍失败|
|原 consumed commit-range|69b340d6|exit 1，canonical 多 issue Refs footer 被当前 checker 拒绝|
|真实远端 PR 普通命名契约，修复前|69b340d6|exit 1，root aggregate 缺少新增精确 source paths|
|真实远端 PR 普通命名契约，修复后|65b390455|340 文件，draft=true，base aaba7b8c；exit 0|

后端合计 **205 通过**，包括 root execution37、export70、metadata inspector18，以及原 checkpoint4 + execution2 的真正隔离 PostgreSQL 控制。adapter/recovery 的替身端口测试不构成 persisted journal、完整 metadata producer 或产品验收。真实 SDK 为 10.0.302；运行 command、exit、时间、assembly/source SHA 与原 TRX 见 payload。

所有 7 个原生失败均为真实 `linux_vault_filesystem_unsupported`。其中 4 个新准备/遍历原生用例已经实际执行，当前状态是 **失败而非未运行**：unknown source 发现、目录数量 bound、create 临时文件 flush/readback、update 后 concurrent edit 拒绝。它们均在原 root admission 处失败，尚未验证其后正向操作。没有替换文件系统资格、伪造 root grant、跳过失败或重放被拒绝的 protected lease/kernel QA。

原 scanner 的零 findings 表示 owner test 不再读取生产 source/directory。禁止文件系统/watch/import/直接 SQL side path、canonical mutation routing、foreground/public fence/rollback 的等价行为仍由原 compiled production assembly 的执行控制检查；不宣称 IL 可以证明 lexical import 不存在。

## 实际已接入 API 与仍缺少的 capability

`LinuxVaultTemporarySourcePreparer.Prepare` 消费 root operation boundary：验证原始 desired bytes、O_EXCL temp、bounded chunk writes、file + directory flush 与 descriptor readback；中断保留 exact operation-owned artifact。它验证的是临时文件，不能提升为 final-source verification 或 accepted-result metadata。`CanExecuteConditionalReplacement=false`、`CanCommitBase=false`。

`LinuxVaultRescanReader.Scan` 消费真实 root directory descriptor，执行两次遍历、strict getdents64 decode、directory stamp/tree drift 检查，以及目录/条目/depth/read/64MiB source budget。unknown source 与读失败仍使 obligation blocked，结构完成仍需要 protected lease 和 actual watcher event-cut/native terminal receipt。`CanAdmitSynchronization=false`。

可合法继续最终 namespace mutation 的前置仍是：真实外部 writer 排除，以及绑定 expected-old bytes/metadata/descriptor identity 和 exact created temp 的条件 replace/remove。root 的进程内 mutex、serialized digest 或两次 path revalidation 都不能授予该前置。需要 canonical lease/native operation owner 的真实 handoff 后，root 才能验证合法的最终 use boundary。禁止以普通 rename、先检查再覆盖或伪造 admission 代替。

最终 path reopen、完整 accepted metadata/permission、recovery journal/base transaction、backup/restore、resume/undo 与 watcher terminal 仍未接受。当前 host 需要原 root verifier 真正支持的任务隔离 Linux filesystem 及权限；Windows NTFS/macOS APFS 当前也未获原生资格。原 Linux arbitrary-digest watermark acknowledgement 的修复仍属于原 watcher owner，本链不重复实现。

canonical `Refs: #2110, #2112` footer 被本仓原 commit-range checker 拒绝，原 source/history 保留；需要协调方/该 owner 提供合法 review lineage。普通 naming 问题已在本链既有 aggregate 精确修复，canonical standalone manifest 保留，未修改原 checker、有限权威、threshold 或 issue 定义。

## 状态与断连检查

[issue-accounting.md](issue-accounting.md) 给出全部49项逐项状态：21 retained root /28 canonical owner；tracking 只汇总，qualification 前置未满足，全部 `accepted=false`。既有 graph/root-recovery 证据保持各自原始候选绑定，本轮不重复原 unchanged graph suite。

协调方报告 executor disconnect 后仅做一次 connectivity check：UTC `2026-10-08T09:27:18Z`，pwd `/workspace/FsusBlog`，git-status 空；三条实际命令均 exit 0。同一 executor 可用，继续尚未完成的证据交接；没有为连接性重跑原生或测试套件。

`manifest.json` 保存 payload hashes，原始 TRX/log 使用无损 gzip 并记录压缩及原始字节 SHA。当前源码仍是 WIP，未获得 native/product/full-chain 验收，也没有 master push、merge、close 或 deployment。
