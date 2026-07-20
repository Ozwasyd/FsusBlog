# Audit detached checkpoints

## Security claim

`sys_audit_log` 的 `RecordMac` 仍只证明记录由持有 `Audit:TamperEvidenceKey` 的一方产生。它不是 WORM，也不能阻止同一 HMAC key 持有者重写整条数据库历史。

detached checkpoint 在这个边界之外增加一套本地、可导出的证明：按 `sys_audit_log.id` 顺序重算现有 audit canonical record hash，把 `id`、`chain_id`、`prev_hash`、stored/canonical record hash、record MAC 与原始 context payload digest 固化为 record snapshot，再复用现有 Merkle builder 生成 order-sensitive root。checkpoint manifest 绑定：

- 单调 `sequence` 与前一 checkpoint digest；
- `fromRecordId` / `toRecordId` / `recordCount`；
- Merkle root 与范围末尾 audit record head hash；
- UTC 创建时间、独立 trust domain 和签名 key identity。

checkpoint 使用独立 `AuditCheckpointKeyRecord` 的 `ECDSA_P256_SHA256` 私钥签名，domain 为 `fsusblog.audit.detached-checkpoint.v1`。该 key 不得复用 Audit HMAC、JWT、PoW、Perception、Site Integrity publish-proof 或 Data Protection key。独立 verifier 只需要 checkpoint 公钥、导入的 checkpoint packages、数据库只读 record source 和可选 expected detached head；它不需要 Audit HMAC 或 checkpoint 私钥。

## What verification detects

完整 chain verification 会 fail closed 检测：

- 数据库记录字段或原始 `context_payload` 修改；
- 持有 Audit HMAC 的攻击者重算 `RecordHash` / `RecordMac` / `PrevHash` 后重写历史；
- checkpoint 范围中的记录删除、替换或重排；
- audit chain link 断裂；
- checkpoint 文件内容、签名、文件名 digest identity 篡改；
- checkpoint sequence 缺口、前驱 digest 不一致或 record range 重叠；
- unknown/wrong/expired/revoked/compromised checkpoint key；
- verifier 持有较新 expected detached head 时，本地 checkpoint tail 被删除或回滚。

expected head 是 `trustDomain + sequence + checkpointDigest + signingKeyId`。只有把它导出到独立信任域并在验证时重新提供，才能检测“删除最新若干本地 checkpoint”这种 tail rollback。若 expected head 和 checkpoint 文件都只留在同一台机器、同一账号和同一备份域，特权攻击者可以一起删除它们。

## Local file transport

`LocalFileAuditCheckpointTransport` 同时实现 pluggable `IAuditCheckpointExporter` / `IAuditCheckpointImporter`：

1. 每个 sequence 先以 `FileMode.CreateNew` 获取独占 sequence lock；
2. canonical JSON package 写入同目录唯一临时文件并 `Flush(flushToDisk: true)`；
3. 使用 `File.Move(..., overwrite: false)` 原子发布；
4. 最终文件名绑定零填充 sequence 和 signed envelope digest；
5. importer 拒绝非 canonical JSON、unknown fields、文件名/digest 不一致与损坏 package。

这提供 append-only create-new 语义和并发 writer 冲突检测，但本地普通文件系统不是 WORM。root/管理员、宿主机特权进程、磁盘管理员或能改写同一备份的人仍可删除整个目录。真正抵抗同主机特权删除需要把 package、public key registry 和 expected head 交给外部保管/WORM/公证域；本 issue 只提供 export/import 接口，不接入 TSA、S3 Object Lock、公共链或任何网络服务。

## Key rotation

轮换时，新 checkpoint 只使用 current private key；独立 verifier registry 保留旧 public key，即可验证旧 checkpoint。旧 private key 不应继续分发。revoked key 只验证撤销时间之前的 checkpoint；compromised key 的所有 checkpoint 都拒绝。public registry 与 exported expected head 应进入和 checkpoint 文件不同的受控发布/备份流程。

## Integration and rollback

中央组合根注册 SQL record source、reload-aware hosted worker、file/export boundary 与 verifier。生产配置通过 `Audit:DetachedCheckpoint` 提供相对 data-root 目录、有界执行周期/批量、唯一 current key identity，以及独立的 SPKI/PKCS#8 DER 路径；私钥文件在 Unix 上不得宽于 0600。worker 每轮先验证已有 checkpoint 与数据库，再创建下一批并用新 expected head 复验。实现不新增 HTTP/admin API，也不接入外部服务。

无需重启的安全回退是热更新 `Audit:DetachedCheckpoint:Enabled=false`，停止 checkpoint creator/scheduler，仅保留现有 Audit HMAC 写入和只读 package；不得在签名 key 缺失、文件 append 冲突或 verification 失败时生成无签名 checkpoint、覆盖旧文件或标记为成功。停止 creator 会降低 detached evidence freshness，但不会改变匿名、登录、admin、notification stream 或 binary API wire 语义。
