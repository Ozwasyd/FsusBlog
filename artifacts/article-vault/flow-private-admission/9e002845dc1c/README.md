# F1 private Flow admission — author delivery, independent review pending

冻结源码 `9e002845dc1c7f6b3b69219b02fed7e1fc0903a2`，tree
`9b8b0857444bccec3ab1a276385712843b75bd61`；起始 origin/master
`9d72a1c93b297f719d8695a642cdfb1615cf1d51`。原分支
`codex/chain-1975-runtime-attempt-borrow`，原 draft PR
[4151](https://github.com/Ozwasyd/FsusBlog/pull/4151)。发布 HEAD 是该源码的仅证据后继，
精确 SHA 由 PR 和最终交付给出；本目录 manifest 绑定全部交付字节，不自称产品资格。

相对 `d8d0e93f913ceecf9c4946df3ad9b0c0283ab8d7`，源码提交只改四个既有路径：
原 runtime、Flow、runtime unit tests、现行 architecture overview。整个 PR 含继承实现
和历史证据，不能描述成只有四文件。本轮修复公开 cleanupRequired 可写导致 Flow
丢弃/替换原 File/context 的 F1。父任务批准的唯一新增 export 是只读
`getImageUploadRuntimeAdmissionError(runtime)`，factory 私有 WeakMap 绑定原返回实例
和原有私有状态 reader；Flow 固定捕获该实例，clear/start/resume/context/capture 前读取。
未知、clone、proxy、继承对象 fail closed。公共 ref 仅显示；返回 null 只代表本地准入。
诊断为新的 code/message，不暴露真实 cause/token/ACK/File/可变闭包。

原独立报告为 `0324` 的154项 PASS但总体 MUST_FIX F1。初始 `^leaf$` 选择器匹配0、
行为 UNRUN；原 reviewer 后续原 probe 实际1FAIL。作者未改原 oracle，只用严格发现后的
后缀锚定 pattern 复现1FAIL，修后同一 probe1PASS。修前原 F1 三个 File/context 断言失败，
硬 message 断言实际 `upload_attachment_input_invalid`，capture仍1；后续 snapshot/cause/
init/complete/zeroabort 断言 UNRUN。另加有效当前 canonical anchor 控制才独立证明修前
capture1→2和实际本地 SDK source变化；修后 capture/source 保持原值。两类证据不混用。

| 冻结源码实际检查 | 结果 |
| --- | --- |
| 原 Vitest discovery/full runtime+API | 167唯一名称，167PASS/0FAIL/0SKIP，167对真实hooks，workers退出 |
| 原 F1严格单项 | 1PASS，150项不在selector内，1对hooks |
| 原九项/原两项positive | 9PASS / 2PASS，各自hooks匹配 |
| 原154/140/139、九/五、old45 | 原完整文件去除新增块/import后字节一致；当前全部PASS |
| 新 admission/reader | 6+6 PASS，false/true、clear/start/resume/capture、File/context、实例和负控 |
| 原37 prerequisite / preflight / style | PASS，命令/exit/run identity及实际producer输出归档 |
| 本次源码 commit-range | PASS，d8..9e |
| 全量 application types | FAIL exit2；current/baseline244/244，完整多行诊断新增0/移除0 |
| 全继承 history | FAIL，旧9defbe367缺Refs；未改历史 |

精确命令、cwd、UTC、run identity、source SHA、exit code见 [records](records/current-runs.json)
及各同名 command record。原 runner `vitest.config.ts`、既有 setup hooks及锁定依赖未改；
实际 local FsusUI `0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2`、Vue3.5.33、
官方 Node24.16.0、Vitest4.1.11、TS6.0.3、HappyDOM20.9。wrapper记录
`FSUSBLOG_USE_LOCAL_FSUSUI=1` /实际 SDK root、workers1和明确 topology env。
复核从现行仓库 setup/preflight开始，再执行 records中的 discovery/focused/f1命令；
归档 helper是本次执行历史，不是替代 runner 或 qualification authority。

新增原 F1+12控制，原154和原9/5绝未更改。最初新增六项 draft oracle 只为遵守父任务
批准的 display-only flag与sanitized diagnostic协议而调整；draft/approved完整字节都以
lossless gzip保留。错误cwd、重复修前执行、缺manifest的旧helper失败、聚合脚本误读
Node输出前缀等失败不删除/升级；具体见 [history](author-history/preparation-failures.json)。
预提交161/167 exploratory PASS不是冻结receipt。老28/17和九/五负史引用已提交原始
SHA/bytes，未伪称本轮重跑旧源码。原两个 reviewer ZIP SHA及补充manifest逐项已验证。

26个自建 dependency links和本轮两份临时隔离fixture已清理；锁定cache及SDK源码保留。
patch反向check PASS，四路径前后 Git blob/sourceimages和source SHA绑定。
本提交后还将从发布Git bytes逐项核验manifest并保持四源码blob完全一致。

[同一reviewer交接](reviewer-handoff.json) 仅交给父任务转发，当前独立复核 PENDING。
[全部16项状态](issue-status.md) 保持OPEN：#1975终态cutover/build/receipt/isolated apply/
repeat/真实backup+restore仍PAUSED，#1976等待实际#1975。其余执行与tracking关口逐项列明。
canonical业务receiver/current receipt/host缺失，#4170 IsSuccess/Recorded不代表浏览器
接收释放或physicaldelete。所有ACK后失败控制zeroabort；另一个precomplete取消控制的
真实mocked abortACK仅属transport取消。没有业务cleanup、Writer/#4153、Shared/#4155、
#4170或server activation，没有production DB/held QA/issue关闭/merge/auto-merge/包发布/
deploy/跨链冲突处理。原回调、正常void及batch控制PASS不授予业务release。
