# Issue #1031：HTTP traffic probe 强证据交接

> 状态：实现与测试代码已落地，但未运行测试、构建、lint、语法检查或治理检查；本文不是验收通过证明。

## 兼容边界

`tools/deployment/release-traffic-probe.mjs` 保留原有 CLI、`fsusblog.release-traffic-scenario.v1` 和 `fsusblog.release-traffic-evidence.v1`。旧 scenario 仍可按原方式运行；只有声明本交接中的扩展字段时，才强制 session chain、逐阶段 release policy、gateway hold 与 HMAC final binding。

扩展参考 fixture：`tests/fixtures/deployment/release-traffic-session-scenario.json`。直接记录型测试：`tests/tools/release-traffic-probe-session.test.mjs`。

## 真实 cookie jar 与 session chain

scenario 的 `sessionChains` 显式列出有序 request id。每条 chain 由独立串行 worker 执行，链内共享内存 cookie jar，不允许 request 自带 `Cookie` 伪造登录态。jar 会处理 domain、host-only、path、Secure、HttpOnly、SameSite、Max-Age、Expires、覆盖与删除语义；每次请求按 URL 选择 cookie，每次响应消费真实 `Set-Cookie`。

request 可用 `cookieAssertions` 声明：

- `requestPresent` / `requestAbsent`
- `responseSet` / `responseDeleted`

ledger 只保留 cookie name、scope/flag 和 value SHA-256，不保留 token 原文。`resetBeforeEachCycle=true` 可让登录 -> refresh -> protected-read 每轮从空 jar 开始；final pass 要求每条 session chain 至少完整成功一轮且没有失败轮次。

## Response header、body、hash 与 AEDS

每个已完成响应都会读取最多 16 MiB 的解压后 body，记录 bytes、SHA-256、选择后的安全 header、HTTP status、release identity、stage、session step 与时间，并进入不可截断的 observation hash chain。不会把 `Set-Cookie` 值写入证据。

`responseAssertions` 支持：

- header：`present`、`absent`、`equals`、`contains`；
- body：精确 `sha256`、`minBytes` / `maxBytes`、`utf8Contains`、JSON Pointer `equals`；
- AEDS：必须是 `application/octet-stream`，校验 `AEDS` magic、v2、16-byte header、flags=0、允许 frame type、payload length、CRC16/A001、payload byte budget 与可选 payload SHA-256。

正文与非公开 header 只用 hash/断言结果进入证据，不回显凭据。所有断言错误进入 stage failure 与完整 `errors`，没有最大错误数或 tail 截断。

## 按 stage/category 精确 release identity

`releaseIdentityPolicy` 使用交叉规则明确 `stages × categories -> allowed source/target roles`。计划必须无重叠并覆盖：

- `status:planned`
- 15 个 rollout stage
- `status:completed`
- 12 个 HTTP category

role 不是信任客户端字符串，而是从当前 rollout state 的 source/target releaseId + slot 精确二元组解析。缺 header、releaseId/slot 混配、未知 identity、未覆盖 stage/category 或命中不允许 role 都计为 deployment failure。stage 之间 `status=running/currentStage=null` 的短间隙绑定到最后完成 stage，避免产生含糊的全局 allowlist。

## 跨 gateway switch 的 hold/in-flight 证明

request 声明 `holdAcrossGatewaySwitch` 后，probe 会保留该请求的 in-flight 起点并在 body 完成后重新读取 rollout state。一次有效观测必须同时满足：

- 起点 `switchCommitted=false`，且不晚于 `gateway-switch`；
- 完成点 `switchCommitted=true`，存在持久 `gatewayGeneration`；
- 响应来自 rollout target；
- 达到 `minimumDurationMs`；
- 请求没有超时或 abort。

final evidence 保留 start/completed context（含各自 rollout-state SHA-256）、duration、target role、body hash、错误和单次 binding hash；最终 pass 要求每个声明的 hold request 至少有一次通过。running snapshot 同时暴露当前 in-flight request，final 暴露 started/max/final counts。

## 不可伪造 final binding

扩展 scenario 声明：

```json
{
  "finalBinding": {
    "schema": "fsusblog.release-traffic-final-binding-plan.v1",
    "required": true,
    "algorithm": "hmac-sha256"
  }
}
```

CLI 必须增加：

```text
--binding-key-file <0400-or-0600-regular-non-symlink-file>
```

key 必须为 32..4096 bytes，不写入 stdout、snapshot 或 final artifact。final binding 使用 canonical JSON 与 HMAC-SHA256 同时绑定：

- rolloutId；
- scenario SHA-256；
- initial/final rollout-state SHA-256；
- 全量 response observation count 与顺序 hash-chain head；
- 不含 `finalBinding` 的完整 final report SHA-256。

输出的 `keyId` 与 `signature` 都是 HMAC 标识。验证方持同一私钥重新 canonicalize unsigned report 与 unsigned binding；任何 body/header/assertion/session/release/hold/rollout 修改都会导致 payload hash 或 signature 不一致。

## 当前接线与治理

强证据已进入唯一 rollout 入口。`release-rollout.sh` 现在要求
`--traffic-binding-key-file`，并把同一 key 传给 public rollout probe、candidate
direct smoke 和 `release-traffic-evidence-verify.mjs`。rehearsal plan 使用
`evidenceInputs.trafficBindingKey`；解析器要求 key 是 32..4096 bytes、0400/0600、
regular non-symlink 文件，编排器只把它复制到每个隔离 run 的 mode-0600 secrets
目录。key 与 admin/session/asset-browser secret 分离，teardown 时删除，动态 report
仅写 `.tmp`。

`--resume` 只在 verifier 重新计算 scenario、rolloutId 与 HMAC 后复用已完成
traffic artifact；文件存在本身不是通过条件。scenario 还必须同时声明 session
chain、完整 release identity policy、跨 gateway 的 hold request 和至少一个 AEDS
frame assertion，任何缺项都会在启动候选前 fail closed。

中央治理已登记：

- `tools/deployment/release-traffic-probe.mjs`
- `tests/tools/release-traffic-probe-session.test.mjs`
- `tests/fixtures/deployment/release-traffic-session-scenario.json`
- `docs/issue-1031-traffic-probe-handoff.md`

上述 producer、session test 与 fixture 已包含在 `zero-downtime-release-rehearsal`
coverage、matrix/requirements owner 和 static governance 中，不再是待接线项。

当前 `zero-downtime-rehearsal.sh`、plan resolver 与 `release-rollout.sh` 已完成上述
参数传递；本文只做静态 readback，未运行任何验证。
