# 私有文章修订历史

作者可以在文章编辑器的 Inspector 打开修订历史。列表按已保存的修订从新到旧排列，标出当前草稿、当前发布和由历史恢复的修订。比较对话框在宽屏并排显示两个已保存修订的标题和原始 Markdown，在窄屏上下排列，标明标题和正文是否变化。基准修订过期或选定版本不可读取时，比较区只显示状态。可以下载选定修订的普通 Markdown 文件。恢复前需要清理编辑器中的未保存更改，并填写 8 至 500 个 Unicode 字符的原因。

- `GET /api/v2/authoring/draft/{id}/revisions.aeds?revision=…` 返回 AEDS 32800。每页最多 20 项，`cursor` 与当前会话、文章和基准修订绑定，同一进程内可继续翻阅。基准变化返回 409，进程重启后从第一页重新打开。
- `GET /api/v2/authoring/draft/{id}/revisions/{sourceRevision}.aeds?revision=…` 返回 AEDS 32801。服务器在同一个授权事务中校验文章所有权、现行基准和历史来源，再读取这两个精确坐标。
- `POST /api/v2/authoring/rollback.aeds` 接受 AEDS 32802。幂等记录锁、现行草稿 CAS、来源副本、新草稿、分类与标签、带执行人及原因的恢复记录和 `draft-rollback` outbox 共享一个提交。重复命令返回原始成功收据。同键不同参数或过期基准返回 409。新草稿发布仍走现有单独的发布命令，现有发布坐标持续生效。

v1 的编辑器比较历史版本与当前表单，摘要包含标题、摘要、头图、分类、标签和正文字数变化。v2 这条比较路径以服务器上已保存的标题和正文为范围。可见发布回滚、责任历史包、签名审计链、签名导出和独立的密封源代码差异计划仍待实现。独立保存的属性值保留其现行值。 [定时发布](article-schedule.md) · [发布权利快照](publication-rights.md)

新数据库的 `plan` 和 `apply` 自动安装历史表。在当前其余表结构匹配的旧 v2 数据库上，先停止服务，再用同一 `FSUSBLOG_DB` 执行离线迁移工具的 `revision-history` 和 `verify`，随后启动新版服务。历史列表继续读取已有修订，新增恢复操作开始记录来源和原因。

[v1 固定提交的 API 契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#L2365)
