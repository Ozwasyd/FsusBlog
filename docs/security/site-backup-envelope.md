# Site Backup Envelope Encryption

`tools/operations/backup-site.sh` 不再输出可直接解包的站点 `.tar.gz`。数据库、uploads、经过 X.509 包装的 Data Protection ring、脱敏配置、AOT 和搜索工件先在 mode-0700/0600 临时目录中生成，再由独立 backup recipient 封装为 `fsusblog-site-backup-envelope-v1`：

- content encryption：AES-256-GCM；
- key wrapping：RSA-OAEP-SHA256，recipient RSA key 至少 3072 bit；
- header 作为 GCM AAD，header、ciphertext 或 authentication tag 任一变化都会使恢复失败；
- 内层 manifest version 2 保存每个 artifact 的 SHA-256、recipient key id，以及 Data Protection encrypted generation 数量；
- 最终文件默认后缀 `.tar.gz.fsbenc`、mode 0600，不能被 `tar` 直接读取；临时明文 tar 无论成功或失败都会删除。

## Key custody

备份和恢复使用的 RSA key pair 独立于 Data Protection X.509、JWT、审计和数据库密钥。

- 备份主机只配置 `FSUSBLOG_BACKUP_RECIPIENT_FILE`，文件必须是 RSA public PEM；工具会拒绝包含 private key 的 recipient 文件。
- restore identity 通过 `FSUSBLOG_BACKUP_IDENTITY_FILE` 提供，必须是 mode 0600 或更严格的 regular non-symlink private PEM。加密 private PEM 的 passphrase 只能由 mode 0600 的 `FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE` 提供。
- private identity 存放在离线/独立 KMS 导出的灾备 secret 域，不得位于 backup root、应用共享数据卷、Data Protection ring、代码仓库、容器镜像、release evidence 或站点包内。
- report 和 manifest 只记录 public SPKI 的 `sha256:` key id，不记录 key path、passphrase、private PEM 或 wrapped content key。

示例：

```bash
FSUSBLOG_BACKUP_RECIPIENT_FILE=/etc/fsusblog/backup-recipient.pem \
FSUSBLOG_BACKUP_ROOT=/srv/fsusblog-backups \
tools/operations/backup-site.sh

FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
FSUSBLOG_RESTORE_ROOT=/srv/fsusblog-restore-staging \
tools/operations/restore-site.sh \
  --backup /srv/fsusblog-backups/fsusblog-site-20260715T010000Z.tar.gz.fsbenc \
  --confirm
```

恢复入口只接受 authenticated envelope。缺 identity、identity 不匹配、权限过宽、明文 tar、截断包、tag/header/ciphertext 篡改、manifest recipient 不一致或 artifact digest 不一致都会在写数据库/uploads/key ring 前阻断。

## Recipient rotation and retention

每个 envelope 只有一个 recipient。轮换按以下顺序进行：

1. 在灾备保管域生成 B，先保存 B private identity 并验证离线恢复权限，再把 B public recipient 分发到 backup host。
2. 用 B 生成一份新 backup，运行 fixture 和隔离 restore drill；manifest/report 必须显示 B 的 public key id。
3. 后续 backup 改用 B。A private identity 在所有 A recipient backup 的法定/业务保留期结束前继续离线保管；它不再分发到 backup host。
4. A backup 全部安全过期销毁并留下审计证据后，才能销毁 A identity。不能因为 B 已上线就提前删除 A。

backup retention 与 identity retention 绑定。任何保留中的 package 都必须有至少一份可用 identity；identity escrow 必须有双人授权、恢复审计和定期可读性检查。Data Protection current/previous PFX 使用独立保留窗口：只要备份 ring 中仍有由旧 PFX 包装的 key generation，灾备域就必须继续保留该 PFX。

## Disaster recovery drill

授权恢复分两层：

1. backup identity 认证并解开站点 envelope；
2. Data Protection current+previous PFX 解开恢复 ring 中对应的 encrypted generations。

`restore-site.sh` 在解包后校验 manifest version、recipient key id、六类 artifact digest、key generation 数量以及每个 key XML 的 `encryptedSecret`/无明文 `masterKey` 约束。`backup-restore-drill.sh` 的 real 模式接收同一 encrypted site package 和外置 identity；当 site package 模式启用时，至少需要 current+previous 两个 encrypted generation，并把实际恢复数量写入 `data-protection-current-previous-generations` check。运行时 rollover tests 继续证明配置了 current+previous PFX 的 blue/green provider 可以双向读取这两代 key。

灾备演练必须在隔离 restore root、隔离数据库/Redis 和非 active web root 中运行。演练证据只保存 status、recipient key id、generation count、artifact digests 的通过状态和 RPO/RTO，不复制 identity、PFX、passphrase、明文 tar 或 key XML。

## Failure and no-restart rollback

备份 envelope 失败不会改变 active runtime：命令删除明文临时包、保留 blocker report，并且绝不回退生成 plaintext archive。修复 recipient 后重新执行即可，无需重启应用。

restore 必须先在隔离 root 完成 authentication、manifest/digest 和 generation checks，再写隔离目标。错误 identity、篡改或缺 generation 时删除临时明文并停止。active slot、共享生产 ring 和当前数据库保持不动，因此无需重启；修复灾备 identity/PFX custody 后重新演练。只有隔离恢复和应用 smoke 全部通过，外部运维流程才可以安排正式切换。

不得把以下行为作为降级：接受旧 plaintext `.tar.gz`、跳过 GCM/tag、忽略 artifact digest、把 private identity 复制到 backup host/shared volume、删除 current/previous key generation，或临时改变 Data Protection `ApplicationName`。
