# Issue #1079: Run-bound physical execution receipts

Local Production 对明确登记的确定性治理命令使用 `fsusblog.physical-execution-receipt.v3`。收据按 `FSUSBLOG_TEST_RUN_ID` 隔离，并绑定 execution key、规范化 argv/cwd、commit、worktree/input digest、相关环境摘要和 output contract。缺少 scheduler run ID 时直接执行，不读取或写入成功复用状态，因此普通本地命令不会跨 Fresh run 缓存测试结论。

## Single-flight 与失败语义

同一 run、同一 execution key、同一完整合同只有一个 producer。并发 consumer 等待 producer 的不可变收据并写各自的 projection；不同 input、environment 或 output contract 会得到不同合同摘要，不会合并。

producer 的 success、failure 或 cancellation 都会写入收据并释放锁。failure 的 exit code/signal 原样传播给所有 consumer，不允许 consumer 静默重跑。收据自摘要或 required artifact digest 不匹配时 projection fail closed。

每个逻辑 projection 记录：

- `physicalExecutionReceipt` 与 digest；
- consumer/test IDs；
- producer/consumer disposition；
- 等待时长与 avoided child startup；
- artifact evidence。

run summary 聚合 physical execution 数、logical consumer 数、dedup hit、避免的 child startup、等待时间和 receipt bytes。

## 首批迁移

| 域 | Execution key | 等价边界 |
| --- | --- | --- |
| Matrix validate/preflight/evidence plan | `matrix-governance` | 统一执行完整 `tools/check-test-matrix.mjs`，由同一收据投影给 build-static、static governance 和 release evidence consumers |
| Backend governance | `backend-test-governance`, `postgres-test-collections` | 普通 backend 与 backend performance 使用相同输入合同；performance 仍分别收集两个失败 |
| Cross-stack | `cross-stack-api-parity`, `cross-stack-frame-schema`, `cross-stack-test-governance`, `cross-stack-binary-matrix`, `cross-stack-negative-matrix`, `cross-stack-runtime-coherence` | 只合并 package script 和 manifest/legacy 入口中 argv、cwd、输入及无输出合同一致的 checker |

未迁移 OpenAPI export、distribution、notification、upload、service-worker 和 performance coherence：这些命令包含生成输出、构建产物、服务状态或性能环境差异，不满足本轮等价合同，不能为了减少进程数强行合并。

## 聚焦验证

```bash
node tests/frontend/checks/static/check-test-execution-helpers.mjs
node tests/frontend/checks/static/check-test-execution-optimization-contract.mjs
node tools/check-test-matrix.mjs
node --test tests/tools/test-matrix-scheduler.test.mjs tests/tools/runtime-cross-stack-split.test.mjs
```

三次相同 SHA、相同机器的完整 Fresh before/after wall-clock、CPU-seconds、spawn count 和 evidence bytes 由最终 production 压测统一回填；在这些测量完成前 #1079 不关闭。
