# FsusBlog TODO

## 进度索引

- CI / 发布门禁：`5/7`
- 长期稳定性 / 3 个月运行证明：`0/8`
- 安全测试 / AppSec：`7/11`
- 供应链安全：`5/7`
- 运行时 / 后端可靠性：`2/8`
- 前端 / PWA / AOT / Hydration：`4/7`
- 数据 / 缓存 / 一致性：`3/6`
- 可观测性 / SLO / 运维证据：`4/6`
- 文档 / 证据一致性：`6/6`
- 总计：`36/66`

## CI / 发布门禁

- [ ] `CI-GATE-001` `quality-gate-branch-trigger-rulesets`
  Scope: 将 Quality Gate 的 push 分支从仅 `main` 改为覆盖实际默认分支，例如 `main` + `master`。
  Dependencies: GitHub branch protection / rulesets 配置入口可用，并确认仓库实际默认分支。
  Done when: workflow 覆盖实际发布分支，且 `coverage`、`production` job 被配置为合并或发布前必须通过。
  Gates: workflow dry run；branch protection / rulesets 截图或 API 输出；`gh workflow view` / `gh api` 证据。
  Comment: Code-level branch trigger updated for `main` + `master` in `.github/workflows/quality-gate.yml`; local default branch evidence is `master` / `origin/master`. External branch protection / rulesets still require GitHub settings evidence, so the item remains open.

- [x] `CI-GATE-002` `coverage-gate-script-closeout`
  Scope: 确认并补齐 `tools/coverage/collect-backend-coverage.sh`、`collect-frontend-coverage.sh`、`merge-coverage.sh`、`check-scope-snapshot.sh`、`check-threshold.sh`。
  Dependencies: 若 coverage 脚本路径已迁移，需同步更新 `tools/test.sh` 与文档。
  Done when: coverage gate 可从统一入口运行，所有引用路径存在且输出 coverage summary。
  Gates: `./tools/test.sh coverage`；`tools/check-gate-integrity.sh`；相关文档路径一致性检查。
  Comment: Done in code. Coverage scripts exist under `tools/coverage/`, are executable, and `tools/test.sh` exposes both `coverage-gate` and `coverage` alias. Verified with `tools/check-gate-integrity.sh` and `bash -n tools/test.sh tools/check-gate-integrity.sh tools/operations/collect-release-evidence.sh`.

- [x] `CI-GATE-003` `gate-integrity-checker`
  Scope: 增加 `tools/check-gate-integrity.sh`，扫描 `tools/test.sh`、`package.json`、workflow 中所有引用脚本。
  Dependencies: 需要定义脚本引用解析规则、可执行权限规则和允许的外部命令白名单。
  Done when: 检查器能发现缺失文件、不可执行脚本、路径漂移和 package/workflow/test.sh 引用不一致。
  Gates: `tools/check-gate-integrity.sh`；故障 fixture 覆盖至少缺失文件、权限错误、路径漂移三类场景。
  Comment: Done in code. Added `tools/check-gate-integrity.sh`, integrated it into the `fast` tier, and verified missing-file, permission-error and path-drift fixtures with `tools/check-gate-integrity.sh --self-test`.

- [x] `CI-GATE-004` `ci-playwright-worker-stability`
  Scope: `tools/test.sh production` 默认 `FSUSBLOG_PLAYWRIGHT_WORKERS=4`，在 GitHub hosted runner 上改为 CI 默认 workers=1，或拆成 sharding 多 job。
  Dependencies: 需要确认本地开发默认值与 CI 默认值的分离机制。
  Done when: CI 以稳定优先方式运行 Playwright，避免资源竞争导致 flake；本地仍可显式提高 workers。
  Gates: GitHub Actions production gate 连续运行证据；Playwright shard 或 workers 配置快照。
  Comment: Done in code. `tools/test.sh production` now defaults Playwright workers to `1` under `CI` / `GITHUB_ACTIONS` and keeps local default `4`; `.github/workflows/quality-gate.yml` pins `FSUSBLOG_PLAYWRIGHT_WORKERS=1`.

- [ ] `CI-GATE-005` `production-release-evidence`
  Scope: 每次 production gate 产出统一 release evidence。
  Dependencies: 需要收集 commit SHA、workflow run id、Docker image digest、SBOM、coverage summary、ZAP 报告、attack matrix、permission matrix、健康检查快照、load 结果。
  Done when: release evidence 目录和 manifest 可复现生成，缺任一关键项会失败。
  Gates: `tools/operations/collect-release-evidence.sh`；manifest schema 校验；一次完整 production gate artifact。
  Comment: Code-level collector now records commit SHA, workflow run, image digest status, coverage, ZAP, attack matrix, permission matrix, supply-chain, SBOM, smoke, load/perf and external exposure evidence; `tools/operations/check-release-evidence-manifest.mjs` validates required fields. The item remains open until a real production gate artifact and external DNS/firewall/live evidence prove `collected-ok`.

- [x] `CI-GATE-006` `controlled-visual-gate-skip`
  Scope: `FSUSBLOG_SKIP_VISUAL_GATE=1` 只能作为受控例外。
  Dependencies: release manifest 需要支持跳过理由、批准人、影响范围和补跑链接。
  Done when: 软跳过 visual gate 时必须留下结构化记录；无记录时 gate fail。
  Gates: production gate skip fixture；release manifest 校验；补跑链接字段校验。
  Comment: Done in code. `FSUSBLOG_SKIP_VISUAL_GATE=1` now requires reason, approver, impact and rerun URL, writes `.tmp/gate-logs/visual-gate-skip.json`, and release evidence indexes the skip artifact. Verified manifest shape with `FSUSBLOG_RELEASE_STAMP=gate-integrity-smoke tools/operations/collect-release-evidence.sh`.

- [x] `CI-GATE-007` `script-doc-consistency`
  Scope: 自动比对 `docs/testing.md`、`docs/operations.md`、`README.md`、`tools/test.sh` 的层级顺序和路径。
  Dependencies: 需要抽取文档命令块和脚本实际入口，覆盖 `tests/server` vs `tests/backend` 这类漂移。
  Done when: 文档命令和脚本入口路径不一致时检查失败。
  Gates: 文档一致性检查脚本；含路径漂移的 fixture；CI gate 集成。
  Comment: Done in code. `tools/check-gate-integrity.sh` scans `tools/test.sh`, `src/frontend/package.json`, `.github/workflows/quality-gate.yml` and docs for stale paths / branch drift; verified with `tools/check-gate-integrity.sh`.

## 长期稳定性 / 3 个月运行证明

- [ ] `STABILITY-001` `soak-test-72h-7d`
  Scope: 增加 72 小时和 7 天 soak test。
  Dependencies: 需要可长期运行的测试环境、隔离 test session、资源采集和失败恢复策略。
  Done when: soak 覆盖匿名公开读、登录/刷新 token、评论、admin、AOT cache、search rebuild、SSE 长连接、Binary 解码、上传、定时发布。
  Gates: 72h soak 报告；7d soak 报告；错误率、资源曲线和关键业务成功率摘要。
  Comment: Pending.

- [ ] `STABILITY-002` `soak-resource-metrics`
  Scope: 在 soak test 中记录长周期资源指标。
  Dependencies: 需要指标采集入口覆盖 app、DB、Redis、文件系统和网关。
  Done when: soak 输出 RSS、managed heap、GC pause、线程数、文件句柄、socket 数、DB 连接池、Redis 连接、SSE 连接数、AOT/search 文件数、日志目录大小。
  Gates: metrics manifest；采样间隔配置；soak evidence 中的资源曲线。
  Comment: Pending.

- [ ] `STABILITY-003` `resource-leak-gate`
  Scope: 给资源曲线设置 fail-fast 阈值。
  Dependencies: 需要定义 24h 后 RSS 增长率、连接数回落、SSE 断连重连成功率、Redis backlog、GC heap slope 等阈值。
  Done when: 资源泄漏或回落失败会让 soak gate fail。
  Gates: 阈值配置；模拟泄漏 fixture；正常 soak 通过证据。
  Comment: Pending.

- [ ] `STABILITY-004` `load-model-tiers`
  Scope: 将 `50 VU × 30s` 扩展为 baseline、expected peak、2× peak、burst、长尾连接多档负载模型。
  Dependencies: 需要明确目标流量假设和每档持续时间。
  Done when: 每档输出 p50/p95/p99、错误率、CPU、内存、DB/Redis 指标。
  Gates: load summary；资源指标关联；阈值失败 fixture。
  Comment: Pending.

- [ ] `STABILITY-005` `sse-long-connection-soak`
  Scope: 把 20 并发 SSE 扩展为长连接 soak。
  Dependencies: 需要支持断网、慢消费者、token 过期、账号封禁、cursor replay、Redis 短断、网关 buffering 错误配置注入。
  Done when: SSE 长连接在故障注入后恢复路径明确，错误率和重连成功率可度量。
  Gates: SSE soak 报告；故障注入日志；replay/cursor 正确性断言。
  Comment: Pending.

- [ ] `STABILITY-006` `scheduled-workers-cross-soak`
  Scope: 对 scheduled publish、search rebuild、AOT backfill、retention cleanup、backup/export 加入长期交错测试。
  Dependencies: 需要可控任务调度和测试数据隔离。
  Done when: 长周期中任务不会互相阻塞、重复执行或污染缓存。
  Gates: worker timeline；幂等断言；缓存一致性快照。
  Comment: Pending.

- [ ] `STABILITY-007` `container-restart-soak`
  Scope: 每个 soak 周期中主动重启 app、Redis、PostgreSQL、网关。
  Dependencies: 需要重启编排脚本和 readiness/error-rate 采样。
  Done when: 每类重启都有恢复时间、错误率和数据一致性证据。
  Gates: restart drill report；readiness timeline；数据一致性断言。
  Comment: Pending.

- [ ] `STABILITY-008` `disk-pressure-scenarios`
  Scope: 注入日志接近满盘、AOT cache 膨胀、uploads 大量小文件、search index 重建失败。
  Dependencies: 需要安全的磁盘压力注入目录和清理策略。
  Done when: 系统降级、报警和恢复路径均有自动化证据。
  Gates: disk pressure fixture；alert evidence；cleanup verification。
  Comment: Pending.

## 安全测试 / AppSec

- [x] `APPSEC-001` `asvs-v5-matrix`
  Scope: 建立 `security/asvs-v5.0.0-matrix.yml`。
  Dependencies: 需要把每个 ASVS requirement id 映射到测试、代码位置、配置、运行证据和人工接受状态。
  Done when: ASVS 矩阵能作为安全控制测试和安全开发需求基准。
  Gates: matrix schema 校验；随机抽样 requirement 到测试/代码/证据的反查。
  Comment: Done in code. Added `security/asvs-v5.0.0-matrix.yml` with ASVS IDs mapped to owner, code, tests and evidence; `tools/security/check-security-matrices.mjs` validates IDs and paths. Verified with `tools/security/check-security-matrices.mjs`.

- [x] `APPSEC-002` `wstg-scenario-matrix`
  Scope: 建立 WSTG 场景矩阵。
  Dependencies: 测试名或报告中使用 `WSTG-v42-*` 或后续版本 ID，避免引用随版本漂移。
  Done when: WSTG 场景可追踪到自动化测试、手工验证或接受状态。
  Gates: WSTG matrix schema；测试命名扫描；报告 ID 校验。
  Comment: Done in code. Added `security/wstg-v4.2-matrix.yml` with `WSTG-v42-*` scenario IDs mapped to owner, code, tests and evidence; validated by `tools/security/check-security-matrices.mjs`.

- [x] `APPSEC-003` `zap-warn-ownership-policy`
  Scope: 对 ZAP WARN 建立 owner、风险接受理由、修复期限和规则状态。
  Dependencies: 需要定义哪些关键规则应从 WARN 改为 FAIL。
  Done when: ZAP WARN 不再只是保留报告，未登记 WARN 会阻断 gate。
  Gates: ZAP report parser；WARN owner registry；FAIL rule policy fixture。
  Comment: Done in code. Added `security/zap-warn-policy.yml` with owner, risk acceptance, fix-by date, status and fail conditions for every ZAP WARN; `tools/security/check-zap-warn-policy.mjs` keeps critical rules at FAIL and runs before ZAP baseline. Verified with `tools/security/check-zap-warn-policy.mjs`.

- [ ] `APPSEC-004` `authenticated-zap-dast`
  Scope: 增加 authenticated ZAP context。
  Dependencies: 需要安全生成登录用户、admin、作者工作台、消息、会话、MFA/Passkey 管理页访问上下文。
  Done when: authenticated DAST 覆盖登录态和 admin 态关键页面。
  Gates: ZAP context 文件；authenticated scan report；session cleanup evidence。
  Comment: Pending.

- [ ] `APPSEC-005` `staging-active-scan`
  Scope: 在 staging 环境增加受控 active scan。
  Dependencies: 不在生产跑攻击性扫描；release 前必须有 staging active scan 报告。
  Done when: release evidence 包含 staging active scan 结果和目标环境标识。
  Gates: staging active scan report；production target deny check；release manifest 字段校验。
  Comment: Pending.

- [x] `APPSEC-006` `aeds-fuzz-property-tests`
  Scope: 对 AEDS header、payload length、CRC、unknown version、oversized frame、truncated frame、nested malformed binary 添加 fuzz/property-based 测试。
  Dependencies: 需要覆盖后端解码、前端解码和协议 fixture。
  Done when: malformed frame 不会导致崩溃、越界、错误响应语义漂移或资源放大。
  Gates: fuzz corpus；property-based test；崩溃回归 fixture。
  Comment: Done in code. Added deterministic malformed-frame fuzz coverage in `AedsEncoderTests` for random bytes, unknown version, invalid header length, oversized declared length, unknown frame type, CRC mismatch and truncation. Verified with `dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj -c Debug --no-restore --filter "FullyQualifiedName~AedsEncoderTests" -v minimal`.

- [ ] `APPSEC-007` `wasm-fuzz-regression`
  Scope: 对 C++23 Wasm 解码/Markdown/LaTeX/Mermaid/render 边界做 fuzz 语料回归。
  Dependencies: 需要 libFuzzer/AFL/wasm-smith 类语料入口，尤其关注后端项目启用 `AllowUnsafeBlocks` 后的边界。
  Done when: Wasm fuzz 语料可在 CI 或定期 job 中复跑并归档崩溃样本。
  Gates: fuzz runner；seed corpus；sanitizer/crash artifact。
  Comment: Pending.

- [x] `APPSEC-008` `webauthn-security-matrix`
  Scope: Passkey 测试补充 RP ID、origin、residentKey、userVerification、excludeCredentials、counter、credential clone、conditional mediation、浏览器差异矩阵。
  Dependencies: 需要浏览器能力探测和 WebAuthn test harness。
  Done when: WebAuthn 关键安全边界有自动化或手工证据。
  Gates: WebAuthn matrix；browser coverage report；negative-case assertions。
  Comment: Done in code. Added `security/webauthn-matrix.yml` covering RP ID, origin, residentKey, userVerification, excludeCredentials, counter/clone, conditional mediation and browser capability tracking; `tools/security/check-security-matrices.mjs` validates it. Verified with `tools/security/check-security-matrices.mjs`.

- [x] `APPSEC-009` `reverse-proxy-trust-attacks`
  Scope: 对 `X-Forwarded-For`、KnownProxies、KnownNetworks、loopback/admin rate-limit bypass 做攻击测试。
  Dependencies: 需要可控代理链模拟和真实客户端 IP 断言。
  Done when: 公网请求无法伪装成可信代理来源或绕过 admin/localhost rate limit。
  Gates: proxy spoofing test；rate-limit bypass negative test；security report。
  Comment: Done in code. `GetClientIp()` no longer trusts raw `X-Forwarded-For` / `X-Real-IP`; it uses the `RemoteIpAddress` already normalized by trusted `ForwardedHeadersMiddleware`, preventing spoofed localhost/admin rate-limit bypass. Added negative tests in `HttpContextExtensionsTests` and updated audit privacy tests/docs. Verified with `dotnet test ... --filter "FullyQualifiedName~HttpContextExtensionsTests|FullyQualifiedName~RequestAuditContextMiddlewareTests|FullyQualifiedName~AuditLogEventMapperTests"`.

- [ ] `APPSEC-010` `csrf-attack-matrix`
  Scope: 保留跨站 form、fetch、method override、preflight bypass、content-type 混淆的自动化攻击矩阵。
  Dependencies: 当前设计使用 SameSite Strict + Bearer JWT，但仍需要负向证明。
  Done when: CSRF 攻击矩阵覆盖匿名、登录、admin 和 binary/json 场景。
  Gates: CSRF attack matrix；browser-based negative tests；security evidence。
  Comment: Pending.

- [x] `APPSEC-011` `privacy-telemetry-snapshots`
  Scope: 对 RUM、OpenTelemetry、audit log、trace id、subscription、author AI assist 做隐私快照测试。
  Dependencies: 需要定义禁止进入 telemetry 的 email/token/cookie/body/IP/UA 字段。
  Done when: 私有字段不会进入 telemetry、日志或 trace artifact。
  Gates: privacy snapshot tests；redaction fixture；release evidence grep。
  Comment: Done in code. Audit mapper now drops Authorization, cookie, token, email, request body, client IP, user agent and username from persisted audit context; RUM/subscription/author AI assist privacy checks already gate frontend/static behavior. Verified with `dotnet test ... --filter "FullyQualifiedName~AuditLogEventMapperTests|FullyQualifiedName~ObservabilityTests"`, `npm --prefix src/frontend run check:telemetry-privacy`, `check:subscription-privacy`, and `check:author-ai-assist`.

## 供应链安全

- [x] `SUPPLY-001` `nuget-audit-gate`
  Scope: 移除 release gate 中默认 `/p:NuGetAudit=false`，或单独加入 `dotnet list package --vulnerable --include-transitive` 强制门禁。
  Dependencies: 需要处理私有源、离线缓存和 CI 网络失败策略。
  Done when: NuGet 高危漏洞会阻断 release gate。
  Gates: `dotnet list package --vulnerable --include-transitive`；漏洞 fixture 或 allowlist policy。
  Comment: Done in code. Added `tools/security/check-supply-chain-audit.sh`, which audits every PackageReference `.csproj` with `dotnet list package --vulnerable --include-transitive --format json` and fails on high/critical blockers. Verified with `tools/security/check-supply-chain-audit.sh`.

- [x] `SUPPLY-002` `npm-audit-gate`
  Scope: `npm ci --no-audit` 可保留为安装加速，但必须增加独立 `npm audit --omit=dev` 或等价工具门禁。
  Dependencies: 需要定义 high/critical 阻断策略和允许的临时接受流程。
  Done when: npm 供应链高危漏洞会阻断 release gate。
  Gates: `npm audit --omit=dev --audit-level=high`；dependency allowlist 校验。
  Comment: Done in code. `tools/security/check-supply-chain-audit.sh` runs `npm audit --omit=dev --audit-level=high --json`, stores `.tmp/security/supply-chain/npm-audit.json`, and fails on high/critical production dependency vulnerabilities. Verified with `tools/security/check-supply-chain-audit.sh`.

- [x] `SUPPLY-003` `sbom-generation`
  Scope: 为 Docker image、NuGet、npm、私有 GitHub Packages 生成 SBOM。
  Dependencies: 需要选择 SBOM 工具和 release evidence 归档格式。
  Done when: release evidence 包含完整 SBOM，并能关联 image digest 与 lock files。
  Gates: SBOM artifact；schema validation；release manifest 引用校验。
  Comment: Done in code. Added `tools/security/generate-sbom.sh`, which creates CycloneDX 1.5 SBOMs for NuGet lock files, npm `package-lock.json` including private GitHub Packages, and container image digest state. Release evidence now copies `.tmp/security/sbom/`. Verified with `FSUSBLOG_IMAGE_DIGEST=sha256:0123456789abcdef tools/security/generate-sbom.sh` and SBOM manifest jq checks.

- [ ] `SUPPLY-004` `image-digest-signing`
  Scope: 生产部署不要只依赖 tag，应记录 image digest，并考虑 cosign/Sigstore 签名。
  Dependencies: 需要容器 registry 权限和签名密钥/无密钥策略。
  Done when: release evidence 记录 digest，部署引用 digest，签名验证可执行。
  Gates: image digest capture；cosign verify 或等价验证；deploy manifest check。
  Comment: Pending.

- [x] `SUPPLY-005` `dependency-review-policy`
  Scope: 对 PR 增加依赖变更 review。
  Dependencies: 需要定义阻断新增高危依赖和 license 风险的规则。
  Done when: dependency review 能识别 npm/NuGet/私有包变化并给出阻断结果。
  Gates: dependency review workflow；license policy fixture；PR check evidence。
  Comment: Done in code. Added `.github/dependabot.yml` for npm, NuGet and GitHub Actions plus `.github/workflows/dependency-review.yml` with high-severity and license-risk blocking. Verified workflow/path consistency with `tools/check-gate-integrity.sh`.

- [ ] `SUPPLY-006` `github-packages-token-hygiene`
  Scope: `GITHUB_PACKAGES_TOKEN` 需要最小权限、短周期轮换、CI secret scanning。
  Dependencies: release evidence 不得泄漏 registry token。
  Done when: token 权限、轮换和泄漏检查都有证据。
  Gates: secret scanning report；release evidence redaction test；token permission checklist。
  Comment: Pending.

- [x] `SUPPLY-007` `lockfile-integrity-policy`
  Scope: `package-lock.json`、NuGet lock file 或 Central Package Management 应作为供应链完整性证据。
  Dependencies: 需要明确 lock file 更新流程和 CI 校验。
  Done when: 隐式版本漂移会被检测并阻断。
  Gates: lockfile check；CI restore locked mode；dependency drift fixture。
  Comment: Done in code. `Directory.Build.props` enables NuGet lock files and CI locked mode, `packages.lock.json` now exists next to each audited `.csproj`, and `tools/security/check-supply-chain-audit.sh` enforces NuGet/npm lockfile presence. Verified with `dotnet restore FsusBlog.slnx -v minimal` and `tools/security/check-supply-chain-audit.sh`.

## 运行时 / 后端可靠性

- [x] `RUNTIME-001` `dataprotection-key-ring`
  Scope: 明确配置持久化 DataProtection key ring。
  Dependencies: 未来多实例或滚动部署时，默认本地 key ring 可能导致 Cookie/JWT 辅助状态、CSRF/加密 payload 或 auth cookie 失效。
  Done when: key ring 持久化位置、权限、备份和滚动部署兼容性明确。
  Gates: configuration test；multi-instance smoke；key rotation drill。
  Comment: Done in code. `AddFsusApiFoundation` now persists DataProtection keys to `DataProtection:KeyRingPath`, `FSUSBLOG_DATA_PROTECTION_KEY_RING`, or `FSUSBLOG_DATA_ROOT/data-protection-keys` with stable application name. Verified by `ServiceCollectionExtensionsTests.AddFsusApiFoundation_PersistsDataProtectionKeysToConfiguredDirectory` and docs updated in `docs/production.md`.

- [ ] `RUNTIME-002` `redis-fault-injection`
  Scope: 对 Redis restart、latency、eviction、只读、连接超时、网络 partition 做真实故障注入。
  Dependencies: 文档提到 Redis 短暂不可用 L1 兜底，但需要运行证据。
  Done when: Redis 故障下系统降级、恢复和错误率符合预期。
  Gates: Redis fault drill；cache fallback evidence；recovery metrics。
  Comment: Pending.

- [ ] `RUNTIME-003` `postgres-pressure-tests`
  Scope: 加入 PostgreSQL 连接池耗尽、慢查询、deadlock、migration 与读写并发、备份期间延迟升高测试。
  Dependencies: 需要可控 DB 压力注入和隔离数据库。
  Done when: DB 压力场景不会破坏数据一致性，错误和降级行为可观测。
  Gates: DB pressure report；deadlock retry/handling tests；backup latency evidence。
  Comment: Pending.

- [x] `RUNTIME-004` `schema-migration-resilience`
  Scope: 每个 schema migration 支持前向、重复执行、失败中断后重跑、旧版本 app 与新 schema 短暂共存。
  Dependencies: 需要 migration fixture 和双版本兼容测试。
  Done when: migration 失败恢复和幂等性有自动化证明。
  Gates: migration integration tests；interrupted-run fixture；old/new app compatibility smoke。
  Comment: Done by existing code and verified now. `SchemaMigrationIntegrationTests` cover forward execution, repeat execution/idempotency, failure interruption behavior, concurrent startup migration and history consistency. Verified with `dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj -c Debug --no-restore --filter "FullyQualifiedName~SchemaMigrationRegistryTests|FullyQualifiedName~SchemaMigrationIntegrationTests" -v minimal`.

- [ ] `RUNTIME-005` `background-worker-reliability`
  Scope: scheduled publish、search rebuild、AOT backfill、retention cleanup 必须有互斥、幂等、失败恢复和超时测试。
  Dependencies: 需要任务调度测试钩子和时间控制。
  Done when: 背景任务异常不会重复污染缓存或阻塞其他任务。
  Gates: worker reliability tests；timeout fixture；idempotency evidence。
  Comment: Pending.

- [ ] `RUNTIME-006` `logging-reliability`
  Scope: 验证 Serilog rolling file、Docker json-file rotation、磁盘限制、权限错误、日志目录不可写时应用行为。
  Dependencies: 需要日志目录权限和磁盘限制故障注入。
  Done when: 日志故障不会导致核心请求路径崩溃，且报警可见。
  Gates: logging fault tests；container log rotation evidence；alert fixture。
  Comment: Pending.

- [ ] `RUNTIME-007` `rate-limit-proxy-validation`
  Scope: 对固定窗口 100/min、queue 2、admin/localhost bypass 做压测和安全验证。
  Dependencies: 需要验证代理 IP 提取与真实客户端 IP 一致性。
  Done when: rate limit 在真实代理链和绕过场景下行为符合安全预期。
  Gates: rate-limit pressure test；proxy IP spoofing negative test；admin bypass evidence。
  Comment: Pending.

- [ ] `RUNTIME-008` `graceful-shutdown-drill`
  Scope: 对 `stop_grace_period: 30s` 做 graceful shutdown 测试。
  Dependencies: 需要覆盖正在上传、SSE、DB transaction、cache write、scheduled publish。
  Done when: SIGTERM 下不会破坏状态，readiness 和恢复行为明确。
  Gates: shutdown drill；in-flight operation assertions；recovery timeline。
  Comment: Pending.

## 前端 / PWA / AOT / Hydration

- [x] `FRONTEND-001` `cross-browser-ci`
  Scope: CI 当前只安装 Playwright Chromium，需要补 Firefox/WebKit。
  Dependencies: 需要处理浏览器差异、WebAuthn 能力探测和 CI 时间成本。
  Done when: 公开页、auth、Passkey 能力探测、PWA cache、hydration、安全头至少在 Chromium/Firefox/WebKit 有覆盖。
  Gates: Playwright browser matrix；cross-browser report；known-unsupported allowlist。
  Comment: Done in code. Playwright config now supports `FSUSBLOG_PLAYWRIGHT_BROWSERS=chromium,firefox,webkit`, Quality Gate installs Chromium/Firefox/WebKit and enables the cross-browser smoke in production, and `acceptance/cross-browser-smoke.spec.ts` covers public shell hydration, auth entry, passkey capability probing, PWA cache names and security headers. Verified with `FSUSBLOG_PLAYWRIGHT_BROWSERS=chromium,firefox,webkit npx playwright test --list acceptance/cross-browser-smoke.spec.ts`.

- [x] `FRONTEND-002` `service-worker-resilience`
  Scope: 增加 SW 更新、旧缓存清理、离线公开页、私有路由离线失败、API 不缓存、cache poisoning、版本回滚测试。
  Dependencies: 需要可控 SW lifecycle 和离线网络模拟。
  Done when: PWA/SW 缓存策略不会泄漏私有数据或污染 API。
  Gates: SW e2e tests；offline report；cache poisoning negative tests。
  Comment: Done in code. `check:pwa-offline-policy` now verifies public-only shell routes, private route exclusion, API/binary no-cache behavior, stale no-store offline responses, legacy cache cleanup, shell invalidation, search refresh and targeted cache clearing; release tier now runs `check:pwa-offline-smoke` for offline public article and private route negative coverage. Verified with `npm --prefix src/frontend run check:pwa-offline-policy`.

- [ ] `FRONTEND-003` `aot-cache-resilience`
  Scope: 增加 AOT cache 跨版本兼容、磁盘损坏、部分文件丢失、旧 hash asset 与新 HTML 混用场景。
  Dependencies: 需要 AOT cache fixture 和文件损坏注入。
  Done when: AOT cache 异常能降级或重建，不造成 hydration 或 SEO 破坏。
  Gates: AOT cache fault tests；hydration smoke；SEO snapshot。
  Comment: Pending.

- [ ] `FRONTEND-004` `hydration-long-smoke`
  Scope: 对 AOT 首屏到 SPA hydration 的状态一致性做长期 smoke。
  Dependencies: 重点覆盖相关文章、评论、搜索索引和 SEO JSON-LD。
  Done when: 长周期 hydration 不出现状态漂移、重复挂载或 SEO JSON-LD 错误。
  Gates: hydration smoke suite；visual/public runtime checks；JSON-LD snapshot。
  Comment: Pending.

- [ ] `FRONTEND-005` `wasm-browser-fallback-matrix`
  Scope: PoW / AEDS / Markdown Wasm 的 threads → SIMD → basic 降级需要在真实浏览器能力矩阵中跑。
  Dependencies: 不能只跑 Node/Chromium，需要覆盖真实浏览器能力差异。
  Done when: Wasm 降级路径在浏览器矩阵中可验证且无功能退化。
  Gates: browser capability matrix；fallback tests；Wasm artifact integrity check。
  Comment: Pending.

- [x] `FRONTEND-006` `asset-size-budget`
  Scope: 对 chunk size、Wasm 大小、Shiki lazy-load、Mermaid/KaTeX 按需加载建立预算门禁。
  Dependencies: 需要定义当前基线和允许增长阈值。
  Done when: 资源大小超预算会阻断 CI 或要求显式接受。
  Gates: build size report；budget config；growth fixture。
  Comment: Done in code. Added `tests/frontend/checks/static/check-asset-size-budget.mjs` and `npm --prefix src/frontend run check:asset-size-budget` to enforce release `dist` total/chunk budgets and write `.tmp/frontend/asset-size-budget.json`. Verified with `npm --prefix src/frontend run check:asset-size-budget`.

- [x] `FRONTEND-007` `public-cache-private-data-leakage`
  Scope: 作者草稿、预览、修订、资产、RUM、subscription 不得进入 PublicAOT、SW shell cache、search index、feed/sitemap。
  Dependencies: 需要 snapshot evidence 和敏感字段扫描规则。
  Done when: 私有数据泄漏路径有自动化负向证明。
  Gates: private-data snapshot tests；search/feed/sitemap scans；SW cache inspection。
  Comment: Done in code. Added `check:public-private-data-leakage` to prove drafts/revisions/private preview/token/email models stay out of PublicAOT, service worker shell cache, feeds/sitemap/search distribution and RUM/subscription paths; fast tier runs it alongside public distribution and privacy checks. Verified with `npm --prefix src/frontend run check:public-private-data-leakage`, `check:public-distribution-contract`, `check:telemetry-privacy`, and `check:subscription-privacy`.

## 数据 / 缓存 / 一致性

- [x] `CACHE-001` `cache-catalog-manifest`
  Scope: 将 cache key/tag/catalog 映射成机器可读清单。
  Dependencies: 现有 `check-cache-governance.sh` 已禁止非白名单直接 Redis 操作和硬编码 cache tag。
  Done when: cache policy、key、tag、失效入口能被静态检查和文档引用。
  Gates: cache manifest generator；governance check；docs sync check。
  Comment: Done in code. Added `tools/cache/export-cache-governance.mjs` and generated `docs/cache-governance.catalog.json` from cache policies, tags and HTTP cache policies. `tools/check-cache-governance.sh` now validates the catalog. Verified with `tools/check-cache-governance.sh`.

- [x] `CACHE-002` `cache-stampede-pressure`
  Scope: 对热门文章缓存击穿、批量失效、Redis miss、AOT cold start 增加并发测试。
  Dependencies: 需要可控缓存清理和并发压测入口。
  Done when: cache stampede 不会造成 DB/Redis 放大或响应失败。
  Gates: stampede pressure test；DB/Redis metrics；p95/p99 summary。
  Comment: Done in code. `CacheMissCoordinator` already uses Redis lease plus local single-flight; added `CoordinateAsync_ManyConcurrentMisses_CoalescesHotKeyRebuild` to prove 64 concurrent misses for the same hot key rebuild once and all callers receive the rebuilt value. Verified with `dotnet test tests/backend/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj -c Debug --no-restore --filter "FullyQualifiedName~CacheMissCoordinatorTests" -v minimal`.

- [ ] `CACHE-003` `l1-l2-invalidation-order`
  Scope: 验证 L1 memory cache 与 Redis L2 在关键写入后的失效顺序。
  Dependencies: 覆盖文章 publish/archive/delete/restore/permanent-delete、评论审核、封禁用户。
  Done when: L1/L2 不会读到过期或越权数据。
  Gates: cache invalidation tests；write/read consistency matrix；Redis key evidence。
  Comment: Pending.

- [ ] `CACHE-004` `search-index-resilience`
  Scope: 对 search rebuild 中断、旧索引残留、新旧 manifest 混用、离线搜索过期做测试。
  Dependencies: 需要 search index fixture 和 manifest 切换模拟。
  Done when: 搜索索引故障能安全降级或恢复，不暴露过期私有数据。
  Gates: search rebuild fault tests；manifest consistency check；offline search snapshot。
  Comment: Pending.

- [ ] `CACHE-005` `aot-search-backup-gate`
  Scope: 备份恢复演练已设计，但应在 release gate 里至少强制 dry-run + 定期 real drill artifact。
  Dependencies: 需要区分 release gate dry-run 和定期真实恢复演练。
  Done when: AOT/search 备份恢复证据进入 release 或定期运维 artifact。
  Gates: backup dry-run；real drill artifact；release manifest 引用。
  Comment: Backup/restore dry-run and fixture evidence exist through `tools/operations/backup-restore-drill.sh`, `tools/operations/test-backup-restore-drill-fixture.sh`, release evidence copy, and daily operations workflow. The item remains open until a scheduled real restore drill artifact is available.

- [x] `CACHE-006` `upload-asset-retention-consistency`
  Scope: 分片上传、过期清理、孤儿资产、引用资产保护要和 retention cleanup 联动验证。
  Dependencies: 需要上传资产引用关系 fixture 和清理任务测试钩子。
  Done when: retention cleanup 不删除被引用资产，孤儿和过期分片能被清理。
  Gates: upload retention tests；asset reference snapshot；cleanup report。
  Comment: Done in code. `tools/operations/cleanup-retention.sh` has an opt-in upload asset guard requiring a referenced-assets manifest; `tools/operations/test-retention-cleanup-fixture.sh` proves referenced upload assets survive while stale unreferenced assets are deleted and counted in `assetGuard`. Verified with `tools/operations/test-retention-cleanup-fixture.sh`.

## 可观测性 / SLO / 运维证据

- [x] `OBS-001` `production-slo-definition`
  Scope: 明确定义生产 SLO。
  Dependencies: 覆盖可用性、错误率、p95/p99、SSE 重连成功率、AOT 命中率、search rebuild 成功率、scheduled publish 延迟。
  Done when: SLO 文档和机器可读阈值可被 gate/告警引用。
  Gates: SLO config；docs sync check；alert rule mapping。
  Comment: Done in code. Added `config/slo.yml` with availability, error-rate, p95/p99 latency, SSE reconnect success, AOT hit rate, search rebuild success and scheduled publish delay objectives; `tools/operations/check-slo-definition.mjs` validates it in fast gate. Verified with `tools/operations/check-slo-definition.mjs`.

- [x] `OBS-002` `slo-alert-release-gate`
  Scope: `check-slo-alert-fixture.mjs` 证明告警定义可执行，但还应要求真实或回放指标证明 release candidate 没有 critical alert。
  Dependencies: 需要指标回放或真实监控查询入口。
  Done when: release candidate 带有 critical alert 时无法 closeout。
  Gates: alert replay check；release manifest alert summary；critical alert fixture。
  Comment: Done in code. Added `tools/operations/check-release-slo-alerts.mjs` and release manifest SLO fields; `collect-release-evidence.sh` marks the manifest `collected-blocked` when SLO replay is missing or any critical alert is firing. Verified with `tools/operations/check-slo-alert-fixture.mjs`, `tools/operations/check-release-slo-alerts.mjs .tmp/operations/slo-alert-fixture.json --allow-critical`, and `tools/operations/check-release-slo-alerts.mjs --self-test`.

- [x] `OBS-003` `post-deploy-smoke-evidence`
  Scope: 把 `FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh` 的真实输出纳入 release closeout。
  Dependencies: 需要真实生产 URL 和 smoke 结果归档路径。
  Done when: post-deploy smoke 不再只是手册步骤，而是 release evidence 的强制项。
  Gates: post-deploy smoke artifact；release manifest reference；failure fixture。
  Comment: Done in code. `post-deploy-smoke.json` is copied into release evidence and is now a required manifest component; missing or non-ok smoke leaves `manifest.status=collected-blocked`. Verified through `tools/operations/test-release-evidence-fixture.sh` and `tools/operations/check-release-evidence-manifest.mjs --self-test`.

- [x] `OBS-004` `release-manifest-required-fields`
  Scope: release manifest 应成为唯一发布凭证。
  Dependencies: 缺 image digest、DNS/firewall/live exposure、coverage、ZAP、attack matrix、smoke 任一项即 `collected-blocked`。
  Done when: release closeout 由 manifest 字段完整性强制驱动。
  Gates: manifest schema；missing-field fixture；closeout blocked evidence。
  Comment: Done in code. `tools/operations/check-release-evidence-manifest.mjs` validates manifest schema and required evidence fields; collector blocks missing image digest, coverage, ZAP, attack/permission matrices, supply-chain, SBOM, smoke, backup drill, SLO, DNS/firewall/live exposure and production status. Verified with `tools/operations/test-release-evidence-fixture.sh` and manifest checker self-test.

- [ ] `OBS-005` `daily-checks-automation`
  Scope: 运维文档中的 daily checks 自动化为定时 job。
  Dependencies: 需要把失败接入告警系统，而不是只依赖人工。
  Done when: daily checks 有定时执行记录、失败告警和修复跟踪。
  Gates: scheduled workflow；alert evidence；operations doc sync。
  Comment: Code-level scheduled workflow added as `.github/workflows/daily-operations-checks.yml` for SLO, backup drill, retention cleanup and release evidence fixtures. The item remains open until failures are wired into the production alerting system rather than only GitHub Actions notifications.

- [ ] `OBS-006` `incident-recovery-drills`
  Scope: Incident Recovery 从手册化步骤升级为定期自动演练。
  Dependencies: 覆盖 Redis outage、DB pressure、SSE pressure、readiness failure。
  Done when: 恢复演练有定期 artifact 和失败跟踪。
  Gates: incident drill reports；recovery-time metrics；alert/closeout evidence。
  Comment: Pending.

## 文档 / 证据一致性

- [x] `DOCS-001` `test-path-consistency`
  Scope: README 中测试路径出现 `tests/server/...`，而当前 solution 和脚本使用 `tests/backend/...`；需要统一。
  Dependencies: 需要扫描 README、docs、TESTING.md、workflow 和脚本中的测试路径。
  Done when: 文档和脚本不再出现冲突路径。
  Gates: docs path consistency script；README/docs diff；CI check。
  Comment: Done in code. README and backend testing docs now use `tests/backend/FsusBlog.Server.Tests`; `tools/check-gate-integrity.sh` rejects stale `tests/server/` and `src/frontend/FsusBlog.Client/` references.

- [x] `DOCS-002` `branch-doc-workflow-consistency`
  Scope: README / docs 说 GitHub Actions 在 `main` push 运行，但仓库默认分支是 `master`；需要统一实际发布分支、workflow、branch protection 和文档。
  Dependencies: 需要确认默认分支和发布分支策略。
  Done when: 文档、workflow 和 branch protection 说法一致。
  Gates: branch config evidence；workflow trigger check；docs consistency check。
  Comment: Done in code. README, `docs/operations.md`, `docs/testing.md`, backend testing docs and `.github/workflows/quality-gate.yml` now agree on `pull_request`, `main` / `master` push and `workflow_dispatch`; local branch evidence is `master` / `origin/master`.

- [x] `DOCS-003` `testing-matrix-yaml`
  Scope: `docs/testing.md` 的关键场景矩阵转成 `tests/matrix.yml`。
  Dependencies: 每项要求绑定脚本、测试文件、owner、证据 artifact。
  Done when: 测试矩阵可被脚本读取并校验覆盖。
  Gates: matrix schema；coverage of matrix entries；docs generation check。
  Comment: Done in code. Added `tests/matrix.yml` with tier command, owner, script and evidence fields, plus `tools/check-test-matrix.mjs` in the fast gate. Verified with `tools/check-test-matrix.mjs`.

- [x] `DOCS-004` `security-doc-traceability`
  Scope: `docs/security.md` 中的安全机制绑定到代码位置、测试位置、ASVS/WSTG 编号和 release artifact。
  Dependencies: 需要 ASVS/WSTG 矩阵和 release evidence 链接格式。
  Done when: 安全文档每个机制都可追踪到代码、测试和证据。
  Gates: security doc trace checker；matrix cross-link validation；artifact link check。
  Comment: Done in code. `docs/security.md` now points to ASVS/WSTG matrices and supply-chain evidence; release evidence copies `security/` as `security-matrices` and indexes supply-chain results. Verified with `tools/security/check-security-matrices.mjs` and release evidence smoke.

- [x] `DOCS-005` `operations-evidence-closeout`
  Scope: `docs/production.md` 和 `docs/operations.md` 的 DNS/firewall/live evidence、backup drill、post-deploy smoke 标注强制级别。
  Dependencies: 需要区分 CI 强制、发布人工 closeout、定期演练。
  Done when: 运维文档与 release closeout 机制一致。
  Gates: operations docs check；release manifest mapping；manual/automated responsibility matrix。
  Comment: Done in code/docs. `docs/operations.md` and `docs/production.md` now distinguish CI-forced evidence, release closeout evidence and scheduled drill evidence, and point final promotion at `tools/operations/check-release-evidence-manifest.mjs --require-ok`. Verified with `tools/check-gate-integrity.sh`.

- [x] `DOCS-006` `gate-drift-detector`
  Scope: 增加脚本校验 README、docs/testing、TESTING.md、tools/test.sh、package.json、workflow 中的命令是否一致。
  Dependencies: 需要命令抽取和等价命令规范化规则。
  Done when: 文档承诺与实际脚本分叉会被 gate 检测出来。
  Gates: gate drift detector；fixture with intentional drift；CI integration。
  Comment: Done in code. `tools/check-gate-integrity.sh` validates command/path drift across `tools/test.sh`, package scripts, workflow and docs; self-test covers missing file, non-executable script and stale path fixtures.
