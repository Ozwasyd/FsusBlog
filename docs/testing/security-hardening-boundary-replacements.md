# Issue #1037：安全 hardening 边界测试替换

Issue #1037 移除五个通过 `File.ReadAllText` 和字符串片段猜测安全实现的 xUnit
测试文件，改由真实服务/端点边界与一套 Roslyn AST policy 承担。旧文件中的 19 个
测试 ID 均记录在 `tests/backend/issue-1037-retention-replacements.json`，不得在中央
retention 合并时静默丢失。

## 当前依赖状态

Issue 正文声明依赖 #1032。2026-07-11 的只读 GitHub 检查显示 #1032 仍为 open、无
评论；GitHub typed dependency API 对 #1037 返回空集合。因此当前事实是“正文依赖”，
不是 GitHub typed dependency。local master 已包含 #1032 implementation commit；coverage、
matrix、backend requirements、static-governance 与 central retention 接线也已存在，但都仍待
统一验证和 GitHub 同步。

## 可观察边界

| 风险域 | 新的权威证据 |
| --- | --- |
| 路径注入 | `CanonicalPathBoundary` 对 URL 编码、反斜杠、绝对路径、词法越界和 symlink 物理越界 fail closed；AOT sidecar、SSR worker 与 admin upload 路径使用同一解析器；本地 fixture 的真实路径 validator 直接执行。 |
| 输入 DoS | 搜索超长关键字在创建数据库 scope 前返回；内容过滤在大分配前拒绝；authoring DataAnnotations、public navigation、subscription、local fixture storage/redirect 和 passkey JSON 深度/长度均从实际入口执行。 |
| 密码学 | 安全 snapshot ID 通过可注入 `ISecurityRandomSource` 使用 CSPRNG；敏感 hex/UTF-8 比较使用 fixed-time helper；最低 Argon2/PBKDF2 参数交给 AST policy。 |
| 信息泄露 | production exception AEDS 响应、startup validation report、local fixture status 与结构化日志字段检查真实输出；AST policy 阻止敏感日志模板及非日志 raw exception 输出。 |
| 上传 | TestServer 执行实际 upload-part handler，覆盖 content type、chunked/缺失 length、声明超限；`FileService` 覆盖 AVIF、目录穿越和取消后无进度/临时产物。 |

上传分片公开 schema 未变化。handler 现在把既有请求体上限显式映射为 `413`，在调用
storage 前返回；Kestrel 的全局上限仍是外层保护。

## 风险与回退

- 路径解析器故障时选择拒绝访问，不回退到只做字符串前缀判断的旧路径。
- Roslyn policy 只检查 `security/backend-source-policy.json` 中列出的 scope，新增规则须同时
  提供 positive/negative fixture，避免用全仓正则制造误报。
- 如果新边界导致兼容性问题，可按域回退调用点；不得恢复已删除的源码字符串测试。上传
  可保持 Kestrel 外层限制并回退 handler 内显式 `413`，不需要重启其他服务。

## 验证状态

按当前并行实施指令，本 issue 尚未执行测试、构建、restore、lint、syntax check 或 analyzer。
所有文件当前仅代表 implementation-only evidence；中央接线后必须据实运行并回填结果。
