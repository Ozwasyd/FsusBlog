# 站点账号保持登录

> **角色**：功能契约
> **适用对象**：站点部署者与身份安全维护者
> **权威依据**：默认开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；刷新链实现以 `src/Server/Identity/SiteRefreshStore.cs` 为准。

## 1. 启用与边界

- 配置站点 Passkey 后，`FSUSBLOG_SITE_PERSISTENT_REFRESH` **默认自动开启**（可显式设为 `false` 静默关闭；显式 `=true` 但无站点 Passkey 时启动报错）。所需刷新表随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。
- 本能力仅适用于普通读者站点会话（`blog_user`）；管理员会话保持严格 2 小时独立生命周期，不参与持久刷新链。

## 2. 会话生命周期与凭据轮换

- 登录页的 **Keep me signed in** 默认未勾选。勾选后，服务端在完成 Passkey 用户验证与已配置的 TOTP MFA 后同时签发访问 Cookie（最长 8 小时）与刷新 Cookie（仅发送到 `/api/v2/identity/refresh`，单次续期最长 30 天、整条会话绝对上限 90 天；均设置 `HttpOnly`、`SameSite=Strict`，HTTPS 下加 `Secure`，绝不在响应正文返回凭据）。
- 浏览器通过同源 `POST /api/v2/identity/refresh/rotate.aeds` 轮换双凭据；在支持 Web Locks 的浏览器中仅单个标签页提交轮换，其余标签页等待后重读会话，网络结果不明时只重读不盲重试。
- 读者标签页静默续期不会干扰已打开的管理员创作工作区，双方会话 Cookie 严格隔离。

## 3. 重放检测与撤销语义

- PostgreSQL 刷新事务保留旧凭据摘要与代次（历史摘要最多保留 30 天）：最近一次轮换的旧凭据在 5 秒并发争用窗口内返回 `409` 且不破坏新 Cookie；超过争用窗口再次出现已轮换旧凭据视为疑似窃取重放，立即撤销整条会话链。未识别凭据不会误伤其他有效会话。
- 显式退出、单个或批量会话撤销、账号代次递增与 Passkey Recovery 重绑均立即终止对应持久刷新链。
