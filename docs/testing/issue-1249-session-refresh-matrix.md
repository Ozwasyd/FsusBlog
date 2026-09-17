# Issue 1249 本地会话刷新矩阵

该矩阵全部使用 Fake Timers、内存 BroadcastChannel/Web Locks mock、本地 PostgreSQL fixture 或 auth API mock，不依赖真实多标签页浏览器、公网、生产 Token 或外部协调服务。

| 场景 | 预期 |
| --- | --- |
| 旧 Access Token 页面恢复 | `/auth/me` 的真实绝对到期时间决定首次 timer，不从页面启动重新计 15 分钟 |
| 两标签同时到期 | 只选出一个 leader 执行 refresh POST；另一个标签只在结算后重验证 `/auth/me` |
| Web Locks 可用 | 独占锁串行化刷新，等待者观察 leader 成功后跳过 refresh |
| 无 Web Locks | BroadcastChannel 同轮 contender 按稳定顺序选 leader |
| leader 退出 | follower 等待有界超时后进入下一轮并接管 |
| 网络失败 | refresh POST 只发送一次；按 5/10/20/40/60 秒上限重试 `/auth/me`，不写 Guest |
| 认证失败/到期 | `authGeneration` 增加，旧身份请求取消，私有缓存、通知流和凭据材料清理 |
| 服务端旧 Token 并发 | 一个请求完成轮换，竞争请求返回冲突；Session family 保持 active |
| 恶意延迟 replay | 超过竞争窗口后继续触发 family revoke |
| 广播最小披露 | 所有 event key/value 均不含 token、session、account 或 proof |

定向前端测试入口：

- `tests/frontend/unit/services/authRefreshCoordinator.test.ts`
- `tests/frontend/unit/services/authSessionRuntime.test.ts`
- `tests/frontend/unit/api/auth.test.ts`
- `tests/frontend/unit/api/binaryApiClient.test.ts`
- `tests/frontend/unit/services/authBroadcastRuntime.test.ts`

后端并发 fixture：`tests/backend/Unit/UserAuthPostgresConcurrencyTests.cs`。测试必须同时断言竞争窗口内不撤销、窗口后 replay 仍撤销，避免用放宽安全策略伪造稳定性。
