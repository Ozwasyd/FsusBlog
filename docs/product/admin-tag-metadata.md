# 管理员标签元数据

配置合法管理员源（统一单源/独立 HTTPS 管理源或本机 Loopback 管理源）后，`FSUSBLOG_ADMIN_TAG_METADATA` 默认自动开启（可通过 `=false` 显式关闭）。管理员使用 Passkey 登录管理后台后即可访问标签元数据与删除入口。

管理员可在管理后台文章工作区的「标签」页创建、编辑或删除未被引用的标签，也可在文章编辑器的「分类与标签」侧边栏直接新建标签并自动选中。名称去除首尾空白并按 NFC 保存，上限为 128 个 UTF‑8 字节。ASCII 纯数字及会被公开链接当作路径分隔符的名称被拒绝。描述去除首尾空白，最多 500 个 Unicode 标量，空白清除描述。稳定数字 ID 继续对应同一个标签。历史名在同一事务保留，旧链接单跳 `301` 到数字页并保留查询参数。已有活跃名称及历史查找键由同一事务检查，跨标签重用时返回冲突。

v2 PUT 使用 32944，请求携带标签 ID、当前元数据版本及请求 UUID。路由 `GET/PUT /api/v2/admin/identity/taxonomy/tags/{id}/metadata.aeds` 返回 32945。命令需要先在同一管理域名请求 `POST /api/v2/admin/identity/taxonomy/tags/{id}/metadata/pow.aeds`，证明绑定当前会话、来源地址、标签、请求体及时限。首次成功操作在同一 PostgreSQL 事务中消费证明并提交标签、别名和审计回执。确切重试使用原请求键返回原回执，不重写元数据。无变化的命令记录回执，保留公开代次。

创建通过 `POST /api/v2/admin/identity/taxonomy/tags/create.aeds`，同源 `tags/create/pow.aeds` 签发证明。创建帧 `33060` 固定使用零 ID 与零修订，响应仍用 `32945`，携带新建的正整数 ID 与元数据修订。创建与改名共用锁，在同一事务保留规范化名称、记录回执并刷新公开代次。已有或历史名称被其他标签占用时整笔回滚。

标签变化推进独立 taxonomy epoch，和原有文章 outbox 水位一起触发公开快照重建。没有文章引用的标签和仅描述变化一样可刷新公开元数据、HTML 和旧链接。关闭管理员编辑开关后仍读取已提交 epoch，无需合成文章、修订或 outbox 记录。默认空 epoch 保留既有公开快照代次。

未被任何已保存文章修订引用的标签可通过 `POST /api/v2/admin/identity/taxonomy/tags/{id}/delete.aeds` 物理删除（同时清理对应保留别名与元数据命令审计记录并推进 `taxonomy_epoch`）；仍存在历史或当前修订引用的标签返回 `409` 冲突。分类写入与删除见[管理员分类与标签目录](admin-taxonomy.md)。
