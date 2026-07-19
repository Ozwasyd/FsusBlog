# 前端会话刷新协调

普通账号页面不再从页面启动时间推算 Access Token 生命周期。`GET /api/binary/auth/me` 在成功响应上提供 `X-Fsus-Access-Expires-At-Utc`，客户端只按该服务端绝对时间减固定安全余量调度刷新；缺失或非法元数据按协议失败处理，不能回退到硬编码 TTL。

刷新采用单 leader：优先使用 Web Locks 串行化 `fsus-auth-refresh-leader`，不可用时通过独立 `fsus-auth-refresh` BroadcastChannel 进行短轮次选举，再不可用时只保留当前标签页内 inflight 去重。协调事件只允许 `v/type/round/contender/at/outcome`，禁止 Token、Session ID、account ID、proof 或用户资料。

leader 成功轮换后必须重新请求 `/auth/me`，确认 Cookie 会话并取得新的绝对到期时间；follower 收到成功结算后也只做 `/auth/me` 重验证，不重复发送 refresh POST。leader 在执行中退出时锁会释放或本轮结算超时，follower 可进入下一轮选举。

Web Locks 可用但 BroadcastChannel 不可用时，只在 `localStorage` 写入最后一次成功结算的毫秒时间戳，供下一个锁持有者判断应改做 `/auth/me` 重验证。该提示不含身份、Token、Session ID 或结果正文，也不能授权请求。

Refresh Token POST 是非幂等安全动作，不做网络错误自动重放。未知网络结果进入 5 秒起、最高 60 秒的有界重验证退避，只重试幂等 `/auth/me`；认证失败才提升 `authGeneration`、取消旧身份请求并清理私有浏览器状态。网络失败期间保持 authenticated/unknown 判定，不直接写 Guest。

服务端仍保留纵深防御：同一 Session 的旧 Refresh Token 在最近一次成功轮换后的短竞争窗口内返回 `409 Conflict`，不删除 Cookie、不撤销会话族；超过窗口的旧 Token 复用继续按 replay 撤销策略 fail closed。

## 运行时回退

- 可通过浏览器策略禁用 Web Locks，运行时自动退到 BroadcastChannel 选举，无需重启。
- BroadcastChannel 不可用时退到单标签页 inflight；不会恢复 refresh POST 自动重放。
- 新响应头是附加 HTTP metadata，不改变 AEDS frame 编号或 POD layout；旧客户端忽略它，新客户端若缺失则停止自动刷新并暴露协议错误。
