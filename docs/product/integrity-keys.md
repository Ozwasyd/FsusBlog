# 公开验证密钥

`GET /integrity/keys.json` 提供签名验证所需的站点公开密钥。响应是普通 UTF-8 JSON sidecar，字段为 `manifestVersion: 1`、`kind: "integrity-key-registry"`、`hashAlgorithm: "sha256"`、可选 `currentKeyId` 及 `keys`。密钥按 `keyId` 排序。单项包含算法和 Base64url DER SubjectPublicKeyInfo，可附带正整数版本、撤销时间和泄露时间。空字段省略，历史公开密钥可保留供独立验证。缓存头沿用 v1 的 60 秒新鲜期和 300 秒后台重验证，响应声明 `Vary: Accept-Encoding`。

读取 `IntegrityProof:Signing:Keys:<id>:PublicKey` 与 `Algorithm`，支持从环境注入相同层级，例如 `IntegrityProof__Signing__Keys__site-2026__Algorithm=ECDSA_P256_SHA256`。v1 接受的 `ecdsa-p256-sha256` 配置别名输出为同一算法 ID。现有部署可通过 `IntegrityProof__Signing__CurrentKeyId` 指定已配置的密钥 ID；重启会重新读取整个配置。缺少公开密钥的条目不进入清单。启动时最多接受 64 个配置项，验证 Base64url、完整 DER SPKI、P-256 和可选时间字段。无匹配公开项时省略当前 ID。响应由公开字段白名单编码，不读取私钥。

与 v1 的配置投影相比，未知算法、无效公开材料和无效状态时间会让新部署拒绝启动。已经启动的应用使用该次校验过的清单，公开端点不联网查询、不生成密钥，也不读取数据库。现行密钥 ID 表示部署者指定的公开坐标。C# 实现了固定 v1 签名载荷的 UTF-8 字节格式，真实 P-256 测试将公开接口取得的 SPKI 导入独立验证对象。发布证明生成、Rights V3 签名、透明日志及 Merkle 检查点仍待接入。 [固定 v1 接口及字段](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Integrity/IntegrityVerificationManifest.cs#L43) · [固定签名载荷](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Integrity/SiteIntegritySigning.cs#L374)
