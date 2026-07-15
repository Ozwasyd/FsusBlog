# Issue #1111 local verification

## Scope

本地验收验证 detached audit checkpoint/export、中央 DI、reload-aware 周期 worker 与生产配置 fail-closed；不调用 TSA、S3、公共链、远程公证或其他外部服务。实现不新增或修改 HTTP endpoint，不改变匿名、登录、admin、notification stream、binary/AEDS 请求与响应。

## Focused commands

```bash
dotnet build src/backend/FsusBlog.Server.csproj --no-restore -c Release

dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --no-restore -c Release \
  --filter 'FullyQualifiedName~AuditDetachedCheckpointTests|FullyQualifiedName~AuditTamperEvidenceBehaviorTests|FullyQualifiedName~AuditLogStoreTests'
```

API/security plane isolation 可用现有 focused contracts 验证：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --no-restore -c Release \
  --filter 'FullyQualifiedName~RequestAuditContextMiddlewareTests|FullyQualifiedName~NotificationStream|FullyQualifiedName~Binary'
```

不运行 `./tools/test.sh production`，也不把一次本地检查描述为生产 WORM 验证。

## Required attack matrix

`AuditDetachedCheckpointTests` 必须覆盖：

- 修改记录但不重算 HMAC：canonical record hash mismatch；
- 持有 Audit HMAC 后重算整条数据库 chain：signed Merkle root mismatch；
- 删除与重排 checkpoint 范围内记录；
- 删除中间 checkpoint、篡改 checkpoint package、使用错误公钥；
- 使用 exported expected head 检测本地 tail rollback；
- 两个 writer 对同一 sequence 并发时只能有一个 create-new 成功；
- current key 轮换后旧 public key 仍验证历史、新 checkpoint 使用新 key；
- verifier/public registry 不包含私钥，也不依赖 Audit HMAC 或 request planes。

测试产生的临时 checkpoint 目录必须在结束时删除；仓库不得提交私钥、runtime checkpoint package、lock/temp 文件或本地数据库快照。
