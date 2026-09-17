# Issue 1246 本地脱敏矩阵

全部验收使用 Vitest 和静态源码门禁，不依赖外部遥测后端、云日志、公网、生产 trace 或真实账户。

| 场景 | 断言 |
| --- | --- |
| 含敏感 URL 的 binary failure | 通用 telemetry CustomEvent 只含固定分类字段，不含 URL/query/hash |
| 匿名、登录账户、admin 请求 | 只保留 `public` / `account` / `admin` 路由分类，不保留请求身份或业务 ID |
| 后端 ApiError message/details/trace | `BinaryTransportError` 仍向调用方保留业务错误语义，但 telemetry payload 不含原值 |
| Token/Proof/Session/Recovery Key | shared redactor 在 audit console 与 safe console 均移除原值 |
| 旧全局事件注入 | `fsus:binary:failure` 不再有监听器，不递增计数、不写 console |
| anonymous auth failure | `suppressAuthFailureTelemetry` 仍保持零遥测 |
| abort/cancel | 不产生失败遥测 |
| telemetry 派发异常 | 不覆盖原始 `BinaryTransportError` |
| 开发 info console | 显式开启后仍使用与生产完全相同的 redactor |
| notification stream | 本次不改变连接、背压或事件分发；其任何 console/audit 参数仍经过同一全局 redactor |

定向测试：

- `tests/frontend/unit/services/binaryTransport.test.ts`
- `tests/frontend/unit/services/telemetryService.test.ts`
- `tests/frontend/unit/services/auditConsole.test.ts`
- `tests/frontend/unit/services/telemetryPrivacy.test.ts`
- `tests/frontend/checks/static/check-telemetry-privacy.mjs`
- `tests/frontend/checks/static/check-private-runtime-governance.mjs`
