# 前端失败遥测隐私边界

二进制请求失败不再通过 `window` CustomEvent 发布原始错误。`binaryTransport` 只调用模块内 `recordBinaryFailureTelemetry`，并把输入投影到固定字段：`operationId`、`routeClass`、`status`、`errorCode`、`category`、`frameType`。原始 URL、query、fragment、后端 message/details、trace、Token、Proof、Session ID、Recovery Key、正文和业务对象 ID 均不会进入该投影。

`telemetryPrivacy.ts` 是浏览器遥测与控制台共用的脱敏边界。binary failure 使用严格 allowlist；audit context 使用敏感键和值 redactor；`safeConsole` 在开发与生产执行相同的参数规约。Error 只保留 name、稳定 code/kind 与 HTTP status，不输出 message、stack 或附加业务字段。debug 开关只能决定 info audit 是否可见，不能绕过脱敏。

`fsus:binary:failure` 与 `fsus:binary:error` 已移除。内部 recorder 生成的分类 payload 仍可进入通用 telemetry bus，但同源监听器只能看到 allowlist 后的稳定枚举。伪造旧全局事件不会递增计数、写 audit console 或触发 telemetry payload。

## 回退与故障语义

- recorder、redactor 或浏览器事件派发失败时，原始请求错误仍按 `BinaryTransportError` 抛出；遥测是 best effort。
- 可在不重启应用的情况下关闭 info audit console；warn/error 仍经过同一 redactor。
- 不提供恢复原始 URL/details/trace 的 debug fallback。需要排障时按 operationId、类别和服务端受控日志关联，不能扩大浏览器数据面。

