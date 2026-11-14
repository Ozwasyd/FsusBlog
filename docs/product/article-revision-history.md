# 私有文章修订历史

作者可以在文章编辑器的 Inspector 打开修订历史。列表按已保存的修订从新到旧排列，标出当前草稿、当前发布和由历史恢复的修订。比较以当前已保存草稿为基准，展示选定修订的原始标题和 Markdown。恢复前需要清理编辑器中的未保存更改，并填写 8 至 500 个 Unicode 字符的原因。

- `GET /api/v2/authoring/draft/{id}/revisions.aeds?revision=…` 返回 AEDS 32800。每页最多 20 项，`cursor` 与当前会话、文章和基准修订绑定，同一进程内可继续翻阅。基准变化返回 409，进程重启后从第一页重新打开。
- `GET /api/v2/authoring/draft/{id}/revisions/{sourceRevision}.aeds?revision=…` 返回 AEDS 32801。服务器在同一个授权事务中校验文章所有权、现行基准和历史来源，再读取这两个精确坐标。
- `POST /api/v2/authoring/rollback.aeds` 接受 AEDS 32802。幂等记录锁、现行草稿 CAS、来源副本、新草稿、分类与标签、带执行人及原因的恢复记录和 `draft-rollback` outbox 共享一个提交。重复命令返回原始成功收据。同键不同参数或过期基准返回 409。新草稿发布仍走现有单独的发布命令，现有发布坐标持续生效。

v1 的历史和回滚使用 AEDS 120、121、213 和 241。v1 管理员回滚可选择 Draft、Published 或 Archived，并消耗敏感操作 MFA 证明。v2 本节提供现有作者编辑权限下的私有草稿恢复。可见发布回滚、已删除文章恢复、Rights V3 及责任历史包、签名审计链和密封源代码差异计划属于仍待完成的 C-02 范围。独立保存的属性值不属于草稿修订快照，草稿恢复会保留其现行值。 [定时发布](article-schedule.md)

新数据库的 `plan` 和 `apply` 自动安装历史表。在当前其余表结构匹配的旧 v2 数据库上，先停止服务，再用同一 `FSUSBLOG_DB` 执行离线迁移工具的 `revision-history` 和 `verify`，随后启动新版服务。历史列表继续读取已有修订，新增恢复操作开始记录来源和原因。

[v1 固定提交的 API 契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#L2365)
