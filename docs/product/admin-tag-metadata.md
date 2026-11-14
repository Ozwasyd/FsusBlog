# 管理员标签元数据

已有 v2 数据库可在停止服务器后运行 `tag-metadata` 安装并校验可选表。开启 `FSUSBLOG_ADMIN_TAG_METADATA=true` 需要独立 HTTPS 管理域名和完整数据库形态。管理员先使用独立 Passkey 登录，由服务器每次核对 `article.write`。作者身份和公开域名不能访问编辑入口。

管理员在「Taxonomy usage」选择标签，编辑名称与描述。名称去除首尾空白并按 NFC 保存，上限为 128 个 UTF‑8 字节。ASCII 纯数字及会被公开链接当作路径分隔符的名称被拒绝。描述去除首尾空白，最多 500 个 Unicode 标量，空白清除描述。稳定数字 ID 继续对应同一个标签。历史名在同一事务保留，旧链接单跳 `301` 到数字页并保留查询参数。已有活跃名称及历史查找键由同一事务检查，跨标签重用时返回冲突。

v2 PUT 使用 32944，请求携带标签 ID、当前元数据版本及请求 UUID。路由 `GET/PUT /api/v2/admin/identity/taxonomy/tags/{id}/metadata.aeds` 返回 32945。命令需要先在同一管理域名请求 `POST /api/v2/admin/identity/taxonomy/tags/{id}/metadata/pow.aeds`，证明绑定当前会话、来源地址、标签、请求体及时限。首次成功操作在同一 PostgreSQL 事务中消费证明并提交标签、别名和审计回执。确切重试使用原请求键返回原回执，不重写元数据。无变化的命令记录回执，保留公开代次。

标签变化推进独立 taxonomy epoch，和原有文章 outbox 水位一起触发公开快照重建。没有文章引用的标签和仅描述变化一样可刷新公开元数据、HTML 和旧链接。关闭管理员编辑开关后仍读取已提交 epoch，无需合成文章、修订或 outbox 记录。默认空 epoch 保留既有公开快照代次。

本切片覆盖标签改名和描述。分类写入、标签合并与删除、v1 帧 34 的 128 字节旧格式及带描述格式的客户端兼容仍独立跟踪。 [冻结 v1 契约](../issues/risk-taxonomy-portability.md)
