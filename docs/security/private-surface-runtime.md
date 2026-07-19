# 私有页面运行时销毁边界

`PrivateSurfaceRuntime` 是账户页和管理页的统一内存边界。用户退出、管理员退出、会话过期或跨标签页账号切换时，运行时按以下顺序执行：

1. 同步进入 clearing 状态并生成新的随机 `authGeneration`。generation 不包含账号、管理员、Cookie 或会话标识，也不会进入 BroadcastChannel 消息。
2. 同步通知终止处理器，中止账户和管理员请求，并停止 Notification Stream、挑战证明运行时以及页面注册的 Worker、定时器和订阅。
3. `App.vue` 在下一次渲染前移除私有路由组件树；清理期间不挂载替代的旧私有内容。
4. 通过私有存储注册表清空相应 Pinia 状态、浏览器缓存和临时凭据。
5. 清理完成后使用 `router.replace` 进入安全路由：账号退出/切换进入公共首页，会话过期进入登录页，管理员退出进入身份页或公共首页。

## 风险与无重启回退

该机制只改变浏览器内存生命周期，不改变 Cookie、API、AEDS 或服务端鉴权语义。若某个终止处理器失败，其余终止处理器仍通过 `Promise.allSettled` 执行，私有存储清理和安全跳转继续进行。运行时不需要重启服务；可通过前端静态资源回滚恢复旧路由挂载策略，服务端会话撤销仍独立生效。

跨标签页广播继续只携带 `type` 与 `at`。不得加入 account id、admin id、generation、权限或 token。
