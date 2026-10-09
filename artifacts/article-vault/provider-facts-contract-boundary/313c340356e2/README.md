# upload facts 类型边界修复

Source `313c340356e2c8f8fc1bcceb550b6526871c12c6`，base `8fa653df73646f720c735ad4b54b649e869a9b9e`，分支 `codex/chain-1975-provider-facts-only`；源提交已推送并核对远端。只消费 sole3735 supplied `df6e81a18e1c4f20f35764e17d1d5f51e2f83ea9` 三文件 hunks，全部 pre/post blob 精确匹配，其他 contracts 字段逐字节保留。此三文件源变更可独立审查。

类型 alias 移至 neutral contracts，API/adapter 使用 type import。官方 TS6.0.3 的三文件 runtime emission 逐字节一致；AST 提取实际相关 interface 与 alias，strict 双向兼容、exact equality、无 bytes 检查零诊断。这是有限类型/输出等价证明。

| 检查 | 实际结果 |
| --- | --- |
| 原 binary-import guard | exit1，仍五处既有失败；新 facts edge 消失 |
| 原 type-import 负控 fixture | exit0，仍能拒绝 API→adapter |
| 原 strict style | exit0，三文件、零违规 |
| 原 source-diff style | exit1，不支持 TS；保留拒绝日志，改用要求的 strict 检查 |
| 两段 commit contract / diff | 全部 exit0 |
| 全应用类型 | 未重跑；原98dc/4cf 均 exit2、271诊断，仍失败 |
| 普通54项控制 | 未重跑或 retag；原98dc的54/54、0skip，通过本轮有限等价证明复用 |

初次 whole-contract 临时快照丢失原模块解析而产生六条 TS2307，记录在 initial-proof-failure.json（解释记录，原 stderr 仅保留在工具输出，未伪造 raw log）。随后仅对实际相关声明执行 scoped equality，完整其余 contracts 内容另有字节证明；无包/API stub、无配置或 checker 放宽。

checks.json 保留命令、exit 和结果位置，range-checks.json 有真实时间和 SHA。verify-equivalence.mjs 使用本任务实际 compiler cache、worktree 和保存的 preimages；复现需准备对应路径。checkpoint.json 是发布前有界 checkpoint，并非最终 HEAD。teardown.json 记录 task-owned frontend cache link 和临时类型目录清理；本轮未创建数据库/浏览器/服务器或重复54。

原54证据位于 `../../provider-facts-only/98dc5c4e01f5/`，其 provider/test/setup hashes 全部保持；旧 guard6/fulltypes271 记录不改写。supplier27、native/SDK、全链资格均未继承。#1975 terminal migration 仍未qualified，#1976等待其acceptance。全部16 issue 状态见 issue-status.md。无 PR/issue/body/comment 写入、关闭、合并、部署或生产数据库动作。

证据目录原样存储 patch 时，context 空行的 Git 前缀空格触发 artifact diff-check exit2；原输出保留。以确定性 gzip 无损保存 supplied-three-hunks.patch.gz（解压字节/hash不变）后重新检查，不改源、checker或空白策略。
原失败日志本身同样包含这些空格，第二次 artifact diff-check exit2也保留为 gzip；两次 raw 日志均无损保存。
未发布的证据 commit 首次使用不支持的 assets scope，change-contract exit1（原输出保留）；仅修正为允许的 docs scope。源 commit 契约已通过且不改写。
