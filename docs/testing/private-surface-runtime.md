# PrivateSurfaceRuntime 验证清单

Issue #1244 的聚焦验证覆盖以下场景：

- 匿名请求：公共路由不使用私有 generation，不因私有清理而重挂载。
- 登录请求：`login` 广播视为账号切换，旧身份请求先中止，旧私有组件树销毁后回到公共安全路由。
- admin 请求：`admin-logout` 只清理管理会话，保留有效账户会话，并跳转身份页。
- notification stream：任一账户失效路径同步停止 stream、清理 cursor 和订阅状态。
- binary：未修改 AEDS 帧、binary 端点、Worker 解码协议或回退语义；现有 binary 契约门禁保持适用。

JSDOM 用例会挂载带旧账号内容的私有组件，向模拟 BroadcastChannel 分别发送 `logout` 与 `expired`，并断言：请求 signal 已 abort、Pinia 身份已清空、旧 DOM 已卸载、随机 generation 已轮换且不含账号标识、清理完成前不会恢复私有 DOM、最终触发安全替换导航。

建议聚焦命令：

```bash
npx vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/services/authBroadcastRuntime.test.ts \
  ../../tests/frontend/unit/services/authSessionRuntime.test.ts \
  ../../tests/frontend/unit/store/user.test.ts \
  ../../tests/frontend/unit/store/admin.test.ts
npm run typecheck:published-fsusui
node ../../tools/frontend/check-auth-broadcast-boundaries.mjs
```
