# 管理控制台行为测试边界

管理控制台的自动化证据以可观察行为为准，不再通过读取 C#、TypeScript、Vue、router 或文档源码并匹配字符串来证明契约。

## 后端边界

- 路由存在性、HTTP method、`admin_permission` 与 `fixed_ip` 限流从实际 `EndpointDataSource` 元数据读取。
- 权限拒绝和高风险操作通过 `TestServer` 请求验证：普通或缺少权限的 principal 收到 `403`，缺少或失效的 Admin step-up proof 收到 `428`，只有有效 proof 被消费后才进入 mutation service。
- 匿名账号列表使用实际 DTO JSON 序列化与 AEDS round-trip，固定公开字段；`LastLoginIp`、密码、私钥、session、device 和内部失败详情不属于响应。
- 标签删除使用 PostgreSQL 行为测试。有 `article_tag` 引用时返回阻塞结果，标签与关联行都保持不变；端点不会暗中解除文章标签。
- Integrity proof retry 使用 PostgreSQL service 测试确认 `failed -> retrying`，同时清除内部失败摘要；端点测试另行确认 permission、origin 与一次性 step-up proof。
- moderation reload、rollback 和运行状态变更由 service 行为测试与 TestServer 共同覆盖；成功变更必须写高价值审计并触发评论缓存失效。

## 前端边界

- API 单元测试检查 URL、HTTP method、AEDS request/response frame、mutation 参数和 `X-Fsus-Mfa-Proof`，不检查函数源码。
- Integrity 控制台组件测试覆盖成功空态、加载错误和 proof retry：先取得 Admin step-up proof，再发送所选 proof id，成功后刷新列表。
- router 与持久导航测试负责 permission 可见性和无权访问跳转；管理控制台 acceptance 负责浏览器中的模块导航、主操作、空态与错误恢复。
- 已退役的 username/password 管理路径由实际路由面、应用端口反射和历史残留治理共同兜底，前端 mutation 只发送匿名 `accountId`。

## 故障与恢复语义

读取失败必须保留页面框架并进入可重试状态，不得展示内部异常详情。高风险 mutation 的 `403`、`428`、`409` 和服务错误应通过共享错误模型呈现；用户重新完成 step-up 后可以重试，但旧 proof 不可复用。

## 责任分工

单元层负责 DTO、AEDS、服务状态机和前端交互；PostgreSQL 层负责真实持久化副作用；TestServer 层负责 endpoint pipeline；浏览器 acceptance 层负责从权限可见性到用户操作结果的完整路径。覆盖率、mutation、retention 和 release evidence 由测试矩阵统一收口。
