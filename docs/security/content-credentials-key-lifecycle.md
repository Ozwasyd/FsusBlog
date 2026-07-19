# Content Credentials 密钥生命周期

Content Credentials 当前不使用 FsusBlog JWT、Cookie、Passkey 或匿名凭据密钥。原型的内置测试证书没有生产信任含义；任何 production-default 决策都必须先迁移到独立 signer 和专用 C2PA 证书链。

## 环境隔离

| 环境 | 私钥位置 | 允许用途 |
|---|---|---|
| local fixture | `c2patool` 内置测试证书或临时测试密钥 | canonicalization、篡改负例、工具接线 |
| CI prototype lane | 仅短生命周期测试密钥；不得上传 artifact | 显式离线互操作 |
| production candidate | 进程外 signer/HSM/KMS 边界 | 演练、受控 opt-in 签名 |
| production default | 仅在全部升级门禁通过后允许 | 已审批内容凭证 |

生产私钥不得进入仓库、appsettings、容器层、标准输出、GitHub Actions artifact、canonical package、manifest definition 或备份明文。应用只保存公开证书链、key id、版本、有效期、撤销状态和签名收据。

## 生成与启用

1. 在隔离 signer 内生成 C2PA 专用密钥，不复用站点 TLS、JWT 或 integrity proof 密钥。
2. 记录算法、证书链、key id、版本、not-before/not-after 和 custody owner。
3. 使用固定 fixture 完成签名与两个独立 implementation family 的离线验证。
4. 验证 manifest 不包含邮箱、IP、设备标识、内部 user id、提示词、私有草稿或模型日志。
5. 仅发布公开证书链；保持 `productionDefault=false`，直到升级收据完整并经操作者审批。

## 轮换

- 新旧证书先并存，旧 manifest 继续用签发时证书验证。
- 新 key 仅对新修订生效，不重签或覆盖历史 manifest。
- 轮换演练必须记录：旧 manifest 仍可验证、新 manifest 使用新 key、静态下载/缓存恢复/重新部署保持一致。
- 在观察窗口结束后停止旧 key 签名，但保留公开证书和撤销信息。

## 撤销、泄露与恢复

发现私钥疑似泄露时：

1. 立即停止该 key 的新签名并将 Content Credentials 发布开关降为 off；正文读取保持可用。
2. 发布带时间和原因码的撤销记录，保留历史 manifest，不伪造成功或删除证据。
3. 区分撤销前的历史凭证与泄露窗口内的新凭证，验证 UI 使用 `credential_revoked`、`credential_compromised`、`digest_mismatch`、`manifest_unavailable` 等固定状态，不自动判定正文恶意。
4. 生成新 key，完成双验证器、轮换和恢复演练后才可恢复 opt-in 签名。
5. 事故报告不得包含私钥、完整内部证书库存、作者身份或私有内容。

备份只包含加密 signer state、公开证书目录、撤销记录和不可变 manifest。恢复演练必须在隔离环境验证：密钥访问权限最小化、历史 manifest 可验证、旧 key 不会意外重新成为 current signer。

## 不重启降级

生产接线前必须提供独立运行时开关，使新签名和页面 manifest 关联可以即时关闭。降级不得修改普通文章 API、binary 帧、notification stream、登录态或管理权限。恢复签名前要重新读取 signer 健康、证书状态和升级门禁，禁止以 fail-open 方式跳过签名验证。
