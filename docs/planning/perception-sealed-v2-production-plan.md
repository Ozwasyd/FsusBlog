# perception-sealed@v2 production tracking plan

本文档是 issue #504 的生产跟踪面。它只记录 `fsu.challenge/perception-sealed@v2` 的落地顺序、子 issue 覆盖和验收边界；运行时代码、provider、Redis、frontend worker、benchmark 与 RiskControl filter 的具体实现必须留在对应子 issue。

机器可校验的 issue map 位于 `docs/planning/perception-sealed-v2-issue-map.json`。更新本计划时必须同步运行：

```bash
node tools/docs/check-perception-sealed-v2-plan.mjs
```

## Production definition

目标组合保持为：

```text
RiskControl + Sealed Perception Challenge + PoW/PoSpace + Passkey Step-up
```

V2 不是“更复杂的图片验证码”。生产定义是轻服务端 sealed perception challenge：

- 服务端不生成 PNG。
- 服务端不 rasterize。
- 服务端不重算图像。
- challenge issue 热路径不写 PostgreSQL。
- challenge issue 热路径不写 Redis。
- verify 热路径只做 AEAD 解封、绑定校验、常量时间比较、Redis SETNX/INCR、proof mint。
- PostgreSQL 只做异步审计和聚合。
- 低风险尽量不出验证码。
- 中风险使用 Character challenge。
- 高风险使用 Localization challenge + PoW。
- 极高风险早拒绝、限流、审核队列或 PoSpace，不继续消耗服务端。

## Non-goals

- 不替代 Passkey / Admin Passkey step-up。
- 不把 HumanReadProof 当作写操作授权。
- 不新增公开 JSON fallback。
- 不在 #504 直接改动 challenge provider、token service、Redis gate、frontend worker、benchmark 或 RiskControl filter 实现。

## Issue coverage

| Order | Issue | Unit | Tracking boundary |
| ---: | ---: | --- | --- |
| 1 | #505 | V2 AEDS contract | issue、assignment、verify、proof 和错误 envelope 进入 binary contract；无公开 JSON fallback。 |
| 2 | #506 | AEAD sealed token | opaque token 绑定 action、route、subject、device / IP / UA hash、过期时间与 nonce。 |
| 3 | #507 | non-semantic render recipe | schema 只描述客户端渲染配方；服务端不生成图片、不保存语义标签。 |
| 4 | #508 | stateless issue path | challenge issue 热路径不写 PostgreSQL / Redis，只签发 sealed assignment。 |
| 5 | #509 | O(1) verify path | verify 只做解封、绑定校验、常量时间比较、Redis gate 与 proof mint。 |
| 6 | #510 | Redis consume-once / attempt gate | replay、过期和尝试次数通过 Redis gate fail closed。 |
| 7 | #511 | Character challenge | 中风险 provider，输出通用 assignment / verify envelope。 |
| 8 | #512 | Localization challenge | 高风险 provider，可与 PoW 组合，失败原因保持通用。 |
| 9 | #513 | Micro Interaction challenge | feature-gated provider，不进入默认生产策略直到 benchmark 通过。 |
| 10 | #514 | RiskControl policy matrix | 低 / 中 / 高 / 极高风险 bands 明确映射到 challenge 或拒绝路径。 |
| 11 | #515 | critical-risk routing | 极高风险优先早拒绝、限流、审核队列或 PoSpace，不继续签发感知挑战。 |
| 12 | #516 | frontend worker renderer | worker 渲染 non-semantic recipe，不与业务表单耦合。 |
| 13 | #517 | FsusUI challenge UI | Character / Localization / Micro Interaction 状态由 provider assignment 驱动。 |
| 14 | #518 | label-oracle hardening | 错误、重试、耗时和失败细节不泄露标签或正确答案。 |
| 15 | #519 | async audit hot-path isolation | PostgreSQL 只记录异步审计与聚合，不进入 issue 热路径。 |
| 16 | #520 | observability / readiness | readiness 区分 disabled、observe、enforce、provider missing 和 fail-closed。 |
| 17 | #521 | red-team benchmark | 覆盖 oracle、replay、成本、自动化攻击和回归基线。 |
| 18 | #522 | admin controls / metrics | admin 控制面要求 admin principal 与 step-up proof；RiskControl proof 不替代 MFA proof。 |
| 19 | #523 | full test matrix | 覆盖 contract、integration、E2E、performance；按相关性包含匿名、登录、admin、notification stream、binary。 |
| 20 | #524 | threat model / protocol / rollout docs | 记录威胁模型、协议、上线阶段、紧急降级和非目标。 |
| 21 | #525 | orchestrator / binary API wiring | provider 只通过 ChallengeOrchestrator 接入；AEDS endpoint 对未知 kind fail closed。 |

## Acceptance checklist for child issues

每个子 issue 必须独立开发、独立测试、独立验收，并满足以下最小交付规则：

- 明确自己的输入 / 输出 contract、配置开关、观测事件和失败语义。
- 只实现本 issue 的最小单元，不抢跑后续 provider、UI、benchmark、policy 或 docs issue。
- 不新增公开 JSON fallback；公开运行时入口保持 AEDS / binary first。
- 不把 HumanReadProof、ordinary RiskControl proof 或 perception proof 提升为写操作授权。
- 涉及 admin 控制面的 issue 必须保持 admin principal、`system.config` 和 `X-Fsus-Mfa-Proof` 边界。
- 涉及生产热路径的 issue 必须说明 PostgreSQL / Redis 是否在 hot path，以及失败时 fail-open / fail-closed 选择。
- 涉及测试的 issue 必须明确覆盖匿名请求、登录请求、admin 请求、notification stream 和 binary 中与该 issue 有关的路径。

## Rollout gates

1. `observe` first：先记录 decision、assignment、verify、replay、failure 和 p95 / p99 solve duration，不阻断低风险流量。
2. Medium-risk enablement：只对中风险启用 Character challenge，并确认 issue path 无 PostgreSQL / Redis 写入。
3. High-risk enablement：Localization + PoW 仅在 Redis consume-once、attempt gate、generic failure 和 metrics 可见后启用。
4. Critical-risk enablement：极高风险走早拒绝、限流、审核队列或 PoSpace；不继续用 perception challenge 消耗服务端。
5. Admin enablement：admin 控制面只读或策略写入必须保持 admin principal + step-up proof，不能用 perception proof 代替。
6. Rollback：优先把相关 action 切回 `observe` 或禁用 provider policy；不得通过放宽 proof 绑定、公开 JSON fallback 或关闭 consume-once 来回退。

## Tracking maintenance

- #504 只维护本计划、issue map 和轻量校验，不承载运行时实现。
- 新增或拆分子 issue 时，先更新 `perception-sealed-v2-issue-map.json`，再更新本表。
- 若子 issue 范围发生变化，必须保证 #504 issue 正文列出的覆盖项仍有独立 issue 承载。
- 关闭 #504 前，`node tools/docs/check-perception-sealed-v2-plan.mjs` 必须通过，并确认所有子 issue 均有独立验收证据。
