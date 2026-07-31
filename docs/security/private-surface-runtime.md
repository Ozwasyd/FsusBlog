# 私有页面运行时销毁边界

`PrivateSurfaceRuntime` 是账户页和管理页的统一内存边界。用户退出、管理员退出、会话过期或跨标签页账号切换时，运行时按以下顺序执行：

1. 同步进入 clearing 状态并生成新的随机 `authGeneration`。generation 不包含账号、管理员、Cookie 或会话标识，也不会进入 BroadcastChannel 消息。
2. 同步通知终止处理器，中止账户和管理员请求，并停止 Notification Stream、挑战证明运行时以及页面注册的 Worker、定时器和订阅。
3. `App.vue` 在下一次渲染前移除私有路由组件树；清理期间不挂载替代的旧私有内容。
4. 通过私有存储注册表清空相应 Pinia 状态、浏览器缓存和临时凭据。admin scope 的 `fsusblog-article-recovery-journal` IndexedDB 同时在 admin/account logout、账号切换、会话过期、隐私清理和 shared-device 清理时删除；文章发布、删除和显式丢弃由文章 owner 做更窄的 scope cleanup。
5. 清理完成后使用 `router.replace` 进入安全路由：账号退出/切换进入公共首页，会话过期进入登录页，管理员退出进入身份页或公共首页。

## 风险与无重启回退

该机制只改变浏览器内存生命周期，不改变 Cookie、API、AEDS 或服务端鉴权语义。若某个终止处理器失败，其余终止处理器仍通过 `Promise.allSettled` 执行，私有存储清理和安全跳转继续进行。运行时不需要重启服务；可通过前端静态资源回滚恢复旧路由挂载策略，服务端会话撤销仍独立生效。

跨标签页广播继续只携带 `type` 与 `at`。不得加入 account id、admin id、generation、权限或 token。

文章恢复协调使用独立、版本化的 body-free BroadcastChannel 消息，只携带
`type/articleKey/tabId/at`；正文、identity、revision 和 source hash 不进入广播。
BroadcastChannel 不可用时页面以低频 IndexedDB 检查发现其他标签页版本，不允许用
localStorage 全文事件作为回退。清理失败不会恢复已撤销的服务端会话；下一次私有页面启动
仍需重新校验服务端 session，并再次执行 journal 的 schema、TTL、容量和 identity scope 校验。

Journal 的 v1 raw IndexedDB value 只保存 versioned `gzip-v1` typed-byte payload，
不保存全文 `content` string；逻辑正文与单条 compressed payload 各以 1 MiB 为上限，
总容量按 compressed bytes 计算为 4 MiB。写入调度最多保留一个 in-flight 和一个最新待写
snapshot，中间输入不会形成无界 encode/IDB queue。压缩不是加密，payload 与原始私密正文
具有同等 profile 访问风险；codec 不可用时 journal fail soft，不能回退为 raw 正文，
服务端自动保存仍继续。
