# 站点会话管理

> **角色**：功能契约
> **适用对象**：读者账号安全与后端维护者
> **权威依据**：读者会话管理接口以 `src/Server/Identity/` 源码为准。

## 1. 范围与身份隔离

- 已登录普通读者在 `/user/identity/mfa` 查看并管理自己的活跃会话。列表标记当前浏览器会话，展示实际到期时间、登录方式及 TOTP 二次验证状态，最多返回当前会话及另外 100 条有效会话。
- 本组接口严格服务于普通读者身份（`blog_user` / `fsus-v2-session`）；管理员登录历史与会话隔离独立运行在管理源 `/api/v2/admin/identity/sessions/history.aeds`（见 [独立管理员身份](admin-identity.md)）。

## 2. 接口与防重放契约

- `GET /api/v2/identity/sessions.aeds`（AEDS `32796`，`no-store`）：返回截断标志、记录数以及各会话的会话标识、到期时间戳（Unix 毫秒）、当前浏览器标志、认证方式与 TOTP 标志，不暴露原始会话凭据。
- `POST /api/v2/identity/sessions/{id}/revoke.aeds`：撤销当前账号的指定其他会话（返回 `EmptySuccess 240`）；撤销当前浏览器请走标准登出入口。
- `POST /api/v2/identity/sessions/revoke-others.aeds`：批量撤销当前账号的全部其他有效会话（含已进入刷新期的持久会话，见 [站点账号保持登录](site-persistent-refresh.md)）。
- **防串会话与跨站防护**：三条接口均强制校验 `X-Fsus-Current-Session` 请求头与当前 HttpOnly Cookie 会话一致（MFA 引起凭据轮换后该标识同步更新），结合同源 `Origin` 与 `SameSite=Strict` 防止跨站或他标签页切换账号后的误操作。

## 3. 事务一致性与验证入口

撤销操作受单机实例租约保护：事务先锁定账号行，再复核当前 Cookie 会话、账号代次与有效期后删除目标记录；当前会话与账号代次保持有效，被撤销的 Cookie 立即失效返回 `401`。

```bash
FSUSBLOG_TEST_FLOW=site-sessions bash tests/EndToEnd/run-native.sh
```
