# 站点账号保持登录

`FSUSBLOG_SITE_PERSISTENT_REFRESH=true` 启用普通站点账号的 Passkey 持久登录。新数据库包含刷新表。已有数据库需要停服执行 `site-refresh schema`；运行时只验证结构。已有普通会话不迁移为持久会话，管理端会话保持独立。

登录页的 **Keep me signed in** 默认未选中。选中后，服务端在完成 Passkey 用户验证和已配置的 MFA 后签发访问凭据和刷新凭据。访问凭据在服务器上的有效期最长为八小时。刷新每次最多续期三十天，整个会话最长九十天。持久 Cookie 的到期时间以数据库返回的空闲到期时间为准。

同源 `POST /api/v2/identity/refresh/rotate.aeds` 轮换两个凭据。在支持 Web Locks 的浏览器中，一个标签页提交；其他标签页重新读取服务器会话。网络结果不明时只重读会话。Cookie 使用 HttpOnly 和 SameSite=Strict，HTTPS 使用 Secure，刷新 Cookie 仅发送到 `/api/v2/identity/refresh`。服务端不在响应正文返回凭据。

同一次持久登录的轮换保留已打开的工作区、未保存的草稿和待重试命令。服务器重新确认会话后，客户端沿用同一登录上下文，并按新凭据重新获取私有预览和分页位置。切换账号、撤销当前会话或变更账号权限和代次会清空旧上下文。

刷新事务在 PostgreSQL 中保留旧摘要与代次。最近一次轮换的旧凭据在五秒争用窗口返回 409，Cookie 保持原样。已记录的旧刷新凭据越过窗口后只能撤销其所属会话，未识别的凭据不会撤销任何会话。历史摘要最多保留三十天。显式退出、会话撤销、账号代次变化与 Passkey 恢复继续使对应会话失效。

这是 v2 的不透明会话凭据接口。固定 v1 使用 JWT、`/api/binary/auth/refresh-token` 和独立会话上下文 Cookie，也有受限账号状态。 [固定版本的 v1 刷新规则](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/security/refresh-token-lineage.md)
