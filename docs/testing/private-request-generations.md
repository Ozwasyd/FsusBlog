# 私有请求 generation 验证

聚焦测试使用 deferred Promise 覆盖：

- 账户 A 慢响应尚未完成时切换到账户 B：旧 signal 被 abort，A 的结果不能返回给 Store；B 的新 generation 请求可正常提交。
- 管理员会话变化：只取消旧 admin 请求，不误伤 account generation。
- optional-auth 公共读取：传输不被身份切换主动取消，但旧账户投影在返回前被拒绝。
- 组件卸载：调用方 AbortSignal 继续向统一 lease 传播。
- BroadcastChannel logout/expired/user-expired/account-switch：`PrivateSurfaceRuntime` 在清空 Store 前推进 generation。

场景边界：匿名公共 binary 请求不登记取消；登录请求使用 account generation；admin 请求使用独立 admin generation；Notification Stream 在身份变化时由私有页面运行时停止；binary 解码完成后仍必须通过 generation 提交检查。

静态门禁 `check-private-request-generation.mjs` 会拒绝以下新增旁路：

- 未声明 `privateScope` 的历史 `binaryUrl` 调用；
- API 目录中未通过 `runPrivateRequest` 的直接 `fetch`/`binaryRequest`；
- binary transport 缺失统一 lease 或响应提交检查；
- 身份变化未推进 generation。
