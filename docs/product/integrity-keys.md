# 公开验证密钥

> **角色**：功能契约
> **适用对象**：站点部署者、第三方验签方与维护者
> **权威依据**：密钥清单加载与输出实现见 [`IntegrityKeys.cs`](../../src/Server/Content/IntegrityKeys.cs) 与 [`PublicationProofKeys.cs`](../../src/Server/Content/PublicationProofKeys.cs)。

## 1. 公开密钥清单端点

`GET /integrity/keys.json` 以标准 UTF-8 JSON sidecar 公布站点用于发布签名与检查点验签的公开密钥集合：

- 顶层字段固定为：`manifestVersion: 1`、`kind: "integrity-key-registry"`、`hashAlgorithm: "sha256"`、可选 `currentKeyId` 以及按 `keyId` 排序的 `keys` 数组。
- 单项包含 `algorithm`（统一输出为 `ECDSA_P256_SHA256`）与 Base64url 编码的 DER SubjectPublicKeyInfo（SPKI），可附带正整数 `version`、`notBeforeUtc`、`notAfterUtc`、`revokedAtUtc` 与 `compromisedAtUtc`；空字段省略，历史公开密钥可长期保留供离线验签。
- 响应缓存策略为 60 秒新鲜期与 300 秒后台重验证，并声明 `Vary: Accept-Encoding`；响应仅由公开字段白名单编码，绝不读取私钥。

## 2. 配置与启动准入

通过 ASP.NET Core `IntegrityProof:Signing` 配置节注入（环境变量使用 `__`，详见 [运行与部署配置参考](../reference/configuration.md#7-完整性签名与每日检查点)）：

- `IntegrityProof__Signing__CurrentKeyId` 指定当前生效密钥 ID；
- `IntegrityProof__Signing__Keys__<id>__PublicKey` 与 `Algorithm` 定义单个公钥（兼容 `ecdsa-p256-sha256` 别名，启动最多准入 64 项）；
- 启动阶段严格验证 Base64url、完整 DER SPKI、P-256 曲线参数与状态时间合法性；遇到未知算法、非法密钥材料或冲突时间字段时 fail-closed 拒绝启动。
- 公开端点不联网、不动态生成密钥、不访问数据库。

## 3. 与发布证明及透明日志的衔接

本清单作为浏览器验签与离线验证工具（`tools/verify-publication-proof.mjs`、`verify-publication-head.mjs`、`verify-publication-checkpoint.mjs`）的信任根输入；原生发布证明签发、权利快照、透明日志头与每日 Merkle 检查点完整流程见 [发布权利快照、透明日志与日检查点](publication-rights.md)。
