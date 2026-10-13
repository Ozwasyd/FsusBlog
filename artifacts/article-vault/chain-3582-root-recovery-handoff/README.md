# Root API 与 canonical recovery 增量交接

本轮后端冻结候选为 `4ba2ec2ee96d917ede0ebe57e47d5c08df7296bc`；实际 root API 独立发布于 `5e7fd98bdefc8cbd5c0a405accc383da917dfa3a`。分支为 `codex/chain-3582-current-acceptance-20261008`，草稿为 [PR #3900](https://github.com/Ozwasyd/FsusBlog/pull/3900)。原 graph/operation 交接档案保持不变；本档案不继承旧的 runtime 或产品验收。

|当前可复核项目|候选|结果|
|---|---|---|
|原始集成后端测试，含真正隔离 PostgreSQL|4ba2ec2e|987 通过，0 失败，0 跳过；exit 0|
|原始 Node 源检查|4ba2ec2e|145 通过，0 失败，0 跳过；exit 0|
|6 个自有 C# API/测试文件样式|4ba2ec2e|0 违规；exit 0|
|原始 producer/testing 文档生成器检查|4ba2ec2e|各 exit 0|
|真实远端草稿 PR 元数据与普通命名契约|4ba2ec2e|300 文件；exit 0；base 3466db03，draft=true|
|原始 matrix|4ba2ec2e|exit 1，有限权威 parser/index/owner closure 漂移|
|原始 convergence|4ba2ec2e|exit 1，两个原始替换声明无法解析|
|原始 Linux root path/descriptor|5e7fd98b|3 通过，19 失败，0 跳过；exit 1|
|原始 snapshot|5e7fd98b|52 通过，3 失败，0 跳过；exit 1|

所有 native 失败保留真实 `linux_vault_filesystem_unsupported`；新增正向原生操作未越过 root admission。因此本档案既不证明原生正向能力，也不把 5e7 的结果转成 4ba 的原生验收。真正 PostgreSQL 控制为原 checkpoint 四项和 execution 两项；adapter/recovery/DI 的其余端口替身测试不是持久化 journal 或产品验收。首次缺少 SDK PATH 的样式检查失败已保留，按官方 setup 激活后同源检查通过。

## 依赖方可使用的实际 API

`LinuxVaultRootPathScope` 提供 `OpenDirectoryForEnumeration(string)`、`OpenOwnedParentMetadata(string)` 和 `OpenMutationBoundary(ArticleVaultMaterializationInstruction, VaultFileMetadataObservation?)`。枚举返回真正只读目录 descriptor；控制树与身份收养仍被拒绝。operation boundary 校验原始 sealed instruction、root/identity、旧源字节与 statx 元数据，创建 O_EXCL 0600 的唯一空临时文件，并保留中断 artifact。

boundary 提供 `CreateTemporarySource(CancellationToken)`、`RevalidateExpectedOld(CancellationToken)`、`UseParentMetadata(Action<SafeFileHandle>)` 与幂等 `Dispose()`。临时 body 写入由 canonical writer 负责，实际 readonly parent FD 可供 fsync。API 不含最终 replace/remove；`CanExecuteConditionalReplacement=false`、`CanCommitBase=false`、`RequiresExternalWriterExclusion=true`。进程内 mutex 不构成 protected lease 或 OS 外部 writer 排除。

canonical `ArticleVaultAcceptedSourceAdapter.ReadAsync` 和 `ArticleVaultRecoveryCheckpointReader.ReadAcceptedSourceAsync` 已消费。三份 source 的兼容冲突按授权逐份检查；没有 ours/theirs 盲覆盖。删除的独立普通命名 manifest 被保持删除，真实新增源路径合入 root 现有 aggregate，实际远端 PR 原始契约通过。

实际服务入口 `AddFsusArticleVaultRecoveryReaders(IServiceCollection, string trustedVaultSiteIdentity)` 注册 scoped production adapter/recovery reader。调用 host 必须提供独立可信 site 与已准入 execution checkpoint store；入口不会虚构 store/schema/migration 或自行启用 startup。adapter29、recovery accepted-source13、checkpoint reader4、DI4 项均在 4ba 原测试通过；缺 store、空 site、跨 site、配置漂移和重复注册控制仍保留。

## 尚未通过的门槛

真实受支持 Linux filesystem/casefold/mount、Windows NTFS、macOS APFS 与 protected lease 尚未准入。完整预期旧值条件 namespace mutation、外部 writer 排除、permission/metadata 保留、原生 readback/journal/base commit、真实 encrypted journal backup/restore、resume/undo/cleanup 与生产 site/store 接入未接受。typed property/V1 metadata producer、taxonomy/entity/draft/publication mapping 与实际 transport/terminal 仍有 canonical owner 门槛。禁止用 source、pure proposal 或替身端口控制提升这些验收。

完整 49 项逐项状态见 [issue-accounting.md](issue-accounting.md)，其中 21 项为 retained root 职责，28 项由 canonical owner 实现；8 项 tracking 仅证据汇总，7 项 qualification 前置未满足。所有项目 `accepted=false`；root 编译控制通过不代表整链完成。

`manifest.json` 记录每个证据 payload 的 SHA-256；原始 TRX 以无损 `.trx.txt.gz` 保存，压缩与原始字节 hash 均可复核。每次执行的 command、候选、时间、exit、源输入 hash 与 counter 位于对应 result；日志保留原始失败。没有生产资源、伪造 runtime receipt、被拒绝 lease QA、master push、merge、close 或 deployment。
