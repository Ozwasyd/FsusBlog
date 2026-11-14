# 站点会话管理

登录后打开账号安全页面 `/user/identity/mfa`。会话列表标记当前浏览器，显示实际到期时间、登录方式及是否通过认证器验证。列表最多显示当前会话和另外 100 条有效会话，批量撤销覆盖全部其他会话。单独撤销只作用于同一账号仍有效的会话，撤销当前浏览器使用既有注销入口。站点读者与作者使用同一账号权限规则。

`GET /api/v2/identity/sessions.aeds` 使用 AEDS 帧 32796。主体依次为截断标志、记录数，以及每条记录的会话标识、Unix 纪元毫秒到期时间、当前浏览器标志、认证方式和 TOTP 验证标志。`POST /api/v2/identity/sessions/{id}/revoke.aeds` 和 `POST /api/v2/identity/sessions/revoke-others.aeds` 无需请求体，成功返回既有空成功帧。客户端从当前会话接口或票据登录响应获得 `X-Fsus-Current-Session`，三条会话管理接口均校验该标识与 HttpOnly cookie 确认的当前会话相同。标识由账号 ID 和会话凭据摘要派生，单凭它无法访问任何会话。MFA 引起凭据轮换后标识随之更新。

撤销经当前实例租约保护。事务先锁定站点账号，再复核 cookie 对应会话、账号代次和有效期，最后删除目标并提交。当前会话和账号代次保持有效，已撤销的 cookie 随后不能访问账号接口。其他标签页切换账号或变更登录后，旧页面的操作会失败并清空旧列表。跨站 POST 由同源检查、SameSite cookie 和会话标识共同限制。

固定 v1 站点会话入口使用 `/api/binary/auth/sessions` 与帧 25。它返回会话创建时间和设备标签。v2 的可选持久会话在访问凭据过期后仍可从会话列表撤销。管理端 v1 的 `/api/binary/auth/admin/sessions` 则使用独立管理员主体、`admin.manage` 权限与帧 170。设备历史、管理端会话列表与 v1 会话迁移仍待完成。 [站点账号保持登录](site-persistent-refresh.md) · [v1 认证端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs)
