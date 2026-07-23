# Security domain ownership

`security/` 只保存可审查、不可执行的安全声明，不保存运行输出。#1170 将该域拆成五个互不混用的所有权边界：

| Boundary | Canonical path | Authority |
| --- | --- | --- |
| Control and test matrices | `security/matrices/` | `security/matrices/catalog.json` + `check-security-matrices.mjs` |
| Analyzer and warning policies | `security/policies/` | 每份 policy 自带 schema、version、owner、severity、rationale 与 path scope |
| ZK semantic contracts | `security/zk/contracts/` | circuit、tamper 与 feasibility contracts |
| ZK provenance | `security/zk/provenance/` | trusted setup、local review 与 artifact ownership |
| Static evidence contracts | `security/evidence-contracts/` | 只允许 `contract` / `implementation-attestation`，不得声称 fresh run |

`security/catalog/security-domain.json` 是总目录。它列出每个边界的 owner、checker、精确静态文件清单和运行时选择；`tools/security/check-security-domain-layout.mjs` 聚合报告所有布局、schema、路径、hash 与分类错误，不在首错后停止。根级散落文件、symlink、可执行文件、未登记目录、旧 flat path、把 provenance 当 circuit contract 使用，以及静态契约冒充 fresh/release evidence 都会 fail closed。

## Runtime and hash binding

仓库运行时配置的 `CircuitManifestPath` 必须指向 `security/zk/contracts/`；release/debug 镜像把该目录原样封装到 `/app/security/zk/contracts/`。仓库内 trusted setup 必须指向 `security/zk/provenance/`，生产部署则从只读 `/app/config/zk/` mount 提供真实 setup/key/review；该 mount 不是仓库 ownership 例外。v2 trusted-setup manifest 继续绑定 circuit manifest SHA-256，local-review 继续逐文件绑定 circuit、setup、artifact ownership、实现与测试源；移动或修改任一字节都必须重新审查并更新 hash，不能静默接受旧路径。

## Risk and rollback

该迁移不改变 circuit id、public-input layout、proof system、ceremony state、API、authentication、notification stream 或 AEDS binary 语义。主要风险是部署配置仍指向旧 flat path，或移动后 hash 没有重绑；两者均由启动校验和 repository checker 阻断。无需重启的业务降级仍是 reload `AnonymousIdentity:ZkProd:Enabled=false`，保持匿名 ZK 评论 fail closed；仓库回退则恢复同一提交中的 catalog、路径、配置和 hash bindings，禁止只恢复单个 manifest。

## Verification

```sh
node tools/security/check-security-domain-layout.mjs
node tools/security/check-security-matrices.mjs
node tools/security/comment-privacy-build-contract.mjs
node tools/security/check-zk-comment-v5-manifests.mjs
node tools/security/check-zap-warn-policy.mjs
node --test tests/tools/security-domain-layout.test.mjs
```

场景边界保持不变：匿名请求和普通登录请求仍只能使用已启用且完整绑定的 ZK 配置；admin 不因安全域迁移获得额外权限；notification stream 未改动；binary API 继续只接受 AEDS v2。
