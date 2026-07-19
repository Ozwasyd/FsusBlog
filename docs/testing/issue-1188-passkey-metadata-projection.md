# Issue #1188 Passkey metadata / projection 验收

## 行为所有权

| 场景 | 自动化 owner | 断言 |
| --- | --- | --- |
| assertion flags 更新 | `PasskeyCounterRollbackIntegrationTests` | login/step-up 成功后 signCount、LastUsedAt、BE/BS 同时持久化；变化不撤销 Session |
| stale assertion 并发 | `PasskeySignCountConcurrencyTests` | 较小 counter 不覆盖较大 counter 对应的 flags snapshot |
| 普通注册事务 | `PasskeyRegistrationProjectionIntegrationTests` | credential insert 与 `PasskeyEnabled=true` 同时提交；投影写失败时 insert 回滚 |
| recovery 补绑 | `RecoveryPasskeyCompletionIntegrationTests` | 新 credential、旧 credential 撤销和投影在同一事务 |
| 删除到一枚/零枚 | `PasskeySignCountConcurrencyTests` 与 Passkey integration owner | 行锁保护最后一枚规则，投影按剩余 credential 集合重建 |
| 账号注销 | `UserServiceValidationTests` | 删除 credential 与 `PasskeyEnabled=false` 属于同一注销 transaction |
| drift check/repair/cache | `PasskeyProjectionConsistencyIntegrationTests` | 双向 drift 被发现，只按 credential facts 修复；snapshot bump 失败会回滚数据库修复 |
| 离线命令 | `PasskeyProjectionCommandTests` | check 无需 release identity；repair 必须 `--confirm-repair`；冲突参数 fail closed |
| startup gate | `LifecycleHostedBootstrapServiceTests` | schema/account invariant 后执行 Passkey projection gate |

## 聚焦验证

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore \
  --filter '(FullyQualifiedName~Passkey|FullyQualifiedName~LifecycleHostedBootstrapServiceTests|FullyQualifiedName~UserServiceValidationTests)'

node tools/run-test-matrix.mjs validate
node tools/security/check-security-matrices.mjs
node tools/dotnet/check-csharp-style.mjs --mode changed
```

## 手工审阅清单

- assertion UPDATE 必须同时包含 `signcount`、`lastusedat`、`backupeligible`、`backupstate` 和 `xmin` guard。
- login 与 step-up 只能调用同一 metadata CAS 函数。
- projection check/repair 的日志和 JSON 输出不得包含账号或 credential 标识。
- credential list 不能增加 public key、WebAuthn credential ID、user handle、原始 flags 或精确设备指纹。
- 不得把 BS 变化升级为 clone/compromise，也不得因此撤销独立 admin 或其他普通账号 Session。

## 边界覆盖

- 匿名请求：Passkey login 的 assertion metadata 路径。
- 登录请求：credential list、普通账号 step-up、rename/delete 权限保持不变。
- admin 请求：独立 admin principal 与 admin Passkey 存储不在本 issue 修改范围。
- notification stream：BE/BS 变化不发送 SessionRevoked；只有既有 counter risk 显式账户策略可发送。
- binary：Passkey v2 frame 和 credential list wire layout 未改变，未新增 JSON fallback。

未运行 full production、release 或外部平台验证；本验收仅声明聚焦代码、数据库 integration 和静态门禁结果。
