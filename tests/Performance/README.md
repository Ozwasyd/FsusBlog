# 公开读取负载与容量验收

> **角色**：性能验收协议与工具说明
> **适用对象**：发布负责人与性能优化维护者
> **权威依据**：本目录脚本与 Go 负载客户端直接执行原生 PostgreSQL 18、Kestrel 与反代 TLS 采样；所有数字门槛与资源归属要求以本文为准。

---

## 1. 负载协议与通过门槛

### 固定语料、拓扑与路由配比

- **被测对象**：单一 Release 构建的 `FsusBlog.V2.Server` 进程、独立 Unix socket PostgreSQL 18 数据目录与单站点快照；代理链使用仓库实际交付的反代配置（不得用代理/CDN 响应缓存替代应用层能力）。
- **确定性语料（公开 seed `20261114`）**：12,000 篇公开文章、32 个分类、128 个标签，另加 50 篇私有草稿与 50 篇用于撤回校验的预发布文章（不进入热集）。正文大小分布为 2 KiB（70%）、8 KiB（25%）、32 KiB（5%），不得使用可异常压缩的重复单字。
- **热读集与流量配比**：热请求选取已驻留的 1,200 篇公开文章；每百次请求按确定性配比为 **HTML 首页 20%、HTML 详情 30%、AEDS 首页列表 20%、AEDS 详情 30%**（详情 80% 命中 ID 1–120，20% 命中 ID 121–1200；首页固定第 1 页、20 条）。
- **请求约束**：全部为无凭据 `GET`、HTTP/1.1 keep-alive、`identity` 编码、最多 256 个在途请求、端到端超时 2 s、禁用重试与跳转；所有响应读至流结束并校验状态码、长度、类型、公开代次及周期性内容摘要。仅有效 HTTP `200` 计为成功。

### 阶段与验收门槛

| 阶段 | 工况与步长 | 通过门槛 |
| --- | --- | --- |
| **短档矩阵（`direct` / `proxy`）** | 30 s 预热（2,000 QPS），依次以 2,000、5,000、8,000、10,500 QPS 各稳定 60 s（档间 15 s 冷却） | 10,500 档在**两次独立同输入运行**中均须达到 **≥ 10,000 正确响应/秒**；直连 p95 ≤ 25 ms / p99 ≤ 75 ms；代理 TLS p95 ≤ 40 ms / p99 ≤ 100 ms；错误、拒绝、超时与供给漏发合计 **≤ 0.1%**；零私密数据泄漏 |
| **长时稳态（`soak`，短档达标后执行）** | 30 s 预热后在 8,000 QPS 持续 15 分钟（900 s） | 四条热读路径归因 PostgreSQL 命令与物理连接为 **0**；稳定后进程 RSS **≤ 1.5 GiB**；末 5 分钟 RSS 中位数较第 6–10 分钟增幅 **≤ 10%**；队列不持续增长 |
| **冷读并发（`cold`）** | 3 个未驻留键各 64 并发（HTML/AEDS 各 32）+ 64 个不同 32 KiB 公开键同时并发 | 256 次全部返回正确 `200`；单键合并至多 1 次实际重建；等待端 ≤ 750 ms，leader ≤ 2 s |

> 最终报告必须区分：未运行、环境阻塞、局部试跑、完整运行失败与完整通过。供给者打满资源或送不进目标流量时记为供给不足，不得以较小负载替代验收。

---

## 2. 本机运行命令

在仓库根目录执行（先离线恢复 `src/Web` 依赖与 FsusUI 构建输入）：

```bash
export DOTNET_BIN=/absolute/path/to/dotnet
export PG_TOOLS_DIR=/absolute/path/to/postgresql/bin
mkdir -p artifacts

tests/Performance/run.sh smoke artifacts/p2-smoke-1
tests/Performance/run.sh direct artifacts/p2-direct-1
tests/Performance/run.sh cold artifacts/p2-cold-1
FSUSBLOG_PERF_RUNTIME=1 tests/Performance/run.sh smoke artifacts/p2-runtime-smoke-1
tests/Performance/run.sh soak artifacts/p2-soak-1

export CADDY_BIN=/absolute/path/to/caddy
tests/Performance/run.sh proxy-smoke artifacts/p2-proxy-smoke-1
tests/Performance/run.sh proxy artifacts/p2-proxy-1
FSUSBLOG_PERF_REUSE_CONNECTIONS=1 tests/Performance/run.sh proxy artifacts/p2-proxy-shared-warmup-1

# 慢请求与供给余量诊断
tests/Performance/run.sh peak artifacts/p2-direct-peak-diagnostic
tests/Performance/run.sh proxy-peak artifacts/p2-proxy-peak-diagnostic
tests/Performance/run.sh supplier artifacts/p2-direct-supplier-1
tests/Performance/run.sh proxy-supplier artifacts/p2-tls-supplier-1
```

### 运行器与诊断模式说明

- **隔离与清理**：运行器使用原生 `initdb` 按次创建私有 Unix socket 数据库，在快照源目录构建并执行 `FsusBlog.V2.Cli` `plan`/`apply`/`verify`，退出时强制验证并移除临时 PostgreSQL、Kestrel、Caddy 与临时目录，保留指定证据目录（含 `outcome.txt`、`owner.txt`、`environment.txt`、`*.sha256`、`fixture.json`、`commands.txt` 与 `server-process.csv`）。
- **代理模式（`proxy*`）**：使用仓库交付的 [`deploy/Caddyfile`](../../deploy/Caddyfile) 与按轮独立生成的回环 TLS CA，同时校验裸后端拒绝、转发头重建、Passkey 来源与会话 Cookie。
- **连接复用与 TLS 预建连**：`FSUSBLOG_PERF_REUSE_CONNECTIONS=1` 在单档内共用一个连接池完成预热与计时；`FSUSBLOG_PERF_PRECONNECT_TLS=1` 顺序预建 256 条 TLS 连接以隔离握手开销。
- **运行时观察（`soak` / `FSUSBLOG_PERF_RUNTIME=1`）**：通过私有文件标记划定计时窗口，输出 `runtime-result.json`，独立统计四条热读路由归因的 Npgsql 命令/物理连接、GC 暂停分段分位、堆分配、RSS 与线程池排队，不记录 SQL、客户端路径或凭据。
- **慢请求与供给余量**：`peak`/`proxy-peak` 记录 ≥ 20 ms 慢请求分段与 CLR 暂停交叉；`supplier`/`proxy-supplier` 以 11,000 QPS（660,000 请求）验证供给端余量；可通过 `FSUSBLOG_PERF_SUPPLIER_PROCS` 单独约束负载进程的 `GOMAXPROCS`。
- **负载客户端回归**：运行 `go test -race tests/Performance/{load,cold,load_test}.go` 校验取消收尾、时间分桶与读写计数。

---

## 3. 数字门槛复算与独立双机供给准入

使用 [`tests/Performance/capacity.py`](capacity.py) 复算已完成矩阵的数字门槛：

```bash
python3 tests/Performance/capacity.py --direct PATH_1 --direct PATH_2 --proxy PATH_3 --proxy PATH_4 --require-peak-quorum
```

- `--require-peak-quorum` 校验直连与 TLS 是否各有至少两轮独立峰值通过；未通过时退出码为 `1`，标准输出保留全部传入轮次的原始复算结果。
- 正式双实机验收需由协调方独立保存 `private-supplier.json`（版本 `1`，绑定 `runId`/`invocationId`/`attemptId`、`topology`、`target`、`generation`、双机 `serverHostId`/`supplierHostId` 摘要，以及归档、清单、语料、协议、工具和每档报告的 SHA-256），并在复算时附加 `--private-supplier-inputs TRUSTED_INPUTS` 执行完整准入校验。独立供给客户端通过 `-private-target` 与 `-ca` 指向私网被测目标（默认 `-target` 仅接受显式回环地址）。
