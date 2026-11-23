# P2 公开读取负载

负载口径和全量验收预算见 [P2 验收和负载协议（归档）](../../docs/archive/dev-logs/p2-acceptance.md)。本目录可以重复运行原生 PostgreSQL 和 Kestrel 的直连采样。

```bash
# 在仓库根目录执行，先从锁文件离线恢复 src/Web 的依赖和 FsusUI 构建输入。
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
tests/Performance/run.sh peak artifacts/p2-direct-peak-diagnostic
tests/Performance/run.sh proxy-peak artifacts/p2-proxy-peak-diagnostic
tests/Performance/run.sh supplier artifacts/p2-direct-supplier-1
tests/Performance/run.sh proxy-supplier artifacts/p2-tls-supplier-1
```

- `smoke` 用完整数据集和 3 秒 100 QPS 验证接入。`direct` 依次做 30 秒预热和 60 秒采样的 2,000、5,000、8,000、10,500 QPS 档位。`soak` 做 30 秒预热和 15 分钟 8,000 QPS 采样。跨运行比较时留出足够主机容量，避免同时启动编译器、浏览器测试或其他负载。
- 运行器使用原生 `initdb` 按次创建私有 Unix socket 数据库，在快照源目录中恢复构建并验证，执行当前迁移 CLI 的 plan、apply 和 verify，再以事务导入固定语料。语料包含 12,000 篇常规公开文章、50 篇草稿、50 篇用于撤回测试的预先发布文章、32 个分类和 128 个标签。生产 DSN 不参与运行。启动后的真正 Kestrel 自动获取回环端口。
- Go 标准库驱动固定 20/30/20/30 四类 GET 请求，最多 256 个活动连接，2 秒端到端期限，HTTP/1.1 keep-alive 和 identity 编码。每档预查全部 2,402 个 URL，用源语料检查发布代次、正文、记录位置、AEDS CRC、分类和标签。计时期间检查完整长度、HTTP 状态、类型和代次，并定期计算校验和。首页 AEDS 游标会随时间刷新，校验和只对其游标字符作归一化，仍验证 AEDS CRC 和游标边界。
- `outcome.txt` 记录运行、调用、尝试标识和退出状态。`environment.txt`、`owner.txt`、`source-status.txt`、`*.sha256`、`fixture.json` 与 `commands.txt` 将候选源、构建、锁文件、数据、运行身份及命令关联起来。每档 JSON 分路由提供已发、漏发、正确响应、状态、错误、计时分位和发车延迟。`server-process.csv` 保存采样的服务端 RSS 和 CPU。退出时验证并移除本次私有 PostgreSQL、Kestrel 和临时目录，证据目录保留。

- `cold` 运行四轮，每轮在 64 个已连接的 HTTP 客户端上同时释放请求。前三轮各选一个不同大小的未驻留键，HTML 与 AEDS 各 32 次。最后一轮使用 64 个不同的 32 KiB 公开键。按 fixture 创建日期排除热键，关闭热预查，并在私有服务日志中查验首次准入、实际渲染次数、最大并发、队列排空以及客户响应。正常语料要求 256 个正确 200 响应。诊断记录包含本次运行观测到的错误和服务器取消数。64 个不同键用于检查并发上限，不能覆盖超过 64 个键后的拒绝路径。

代理入口使用交付的 [Caddyfile](../../deploy/Caddyfile) 和每轮独立生成且按次信任的 TLS CA，证书校验包含回环 IP。代理负载和直连使用相同的供给档位及 HTTP/1.1 identity。运行记录包含 TLS 版本、配置、进程归属及 RSS，并检查裸后端拒绝、转发头重建、Passkey 来源和真实会话 Cookie。结束时检查 Caddy 与 Kestrel 的监听均已关闭，并清理本轮证书和数据库。

可选的 `FSUSBLOG_PERF_REUSE_CONNECTIONS=1` 在每档使用一个负载进程和一个连接池。预查发生在 2,000 QPS 预热前，预热请求全部结束后才开启独立计时。每档 JSON 的 `warmup` 保存预热时间、错误、漏发、请求详情和供给数据，`connectionReuse` 报告保留连接及实际在同一连接上尝试和校验通过的计时请求。已被对端关闭的连接可导致首次计时请求失败，新请求才可重新建连。预热和计时各自仍用同一路径选择、摘要校验、256 个在途和 2 秒期限。默认仍使用各自进程和连接池，串行预连接保留为独立模式。此模式只确认客户端至 Kestrel 或 Caddy 的连接复用。

回查近端 TLS 建连影响时，可设 `FSUSBLOG_PERF_PRECONNECT_TLS=1`。客户按顺序完成 256 次 TLS 握手，再按固定速率和并发限制发送同样的 HTTP 请求。预连接数量和耗时单列。计时中的传输失败仍计入，客户端没有透明重试。该试验用于归因，基本代理负载的结果另行保留。

soak 和显式启用运行时观察的 smoke 使用私有文件标记划定计时窗口。观察器在 5 秒采样之外保留阶段开始和结束时的累积值。四条热读由服务端实际路由识别，并单独统计归因到请求的 Npgsql 命令 Activity、物理连接 Activity 和 HTTP 响应数。驱动内部事务控制消息及连接复位不计入命令 Activity。计时之前访问一次真实 PostgreSQL 评论列表验证 HTTP 请求归因，并查验启动期间的物理连接事件。发布轮询及 lease 后台命令单列。诊断不记录 SQL、客户端路径或凭据。GC 按 CLR 实例配对暂停开始、恢复开始和恢复结束三个原生事件。单列暂停至恢复开始、恢复阶段和完整部分的分位。仅前一段与不同时间边界的内置总暂停交叉核验。历史日志只有完整暂停，仍以原口径验算。另采样堆、进程 RSS、冷渲染和线程池排队，运行结束时生成 `runtime-result.json`。 [Npgsql 10.0.3 Activity 实现](https://github.com/npgsql/npgsql/blob/v10.0.3/src/Npgsql/NpgsqlActivitySource.cs) · [.NET 10.0.15 事件定义](https://github.com/dotnet/runtime/blob/v10.0.15/src/coreclr/vm/ClrEtwAll.man)

当前运行器的客户端和服务端共用主机。调度器把已排队和已发出请求一起限制在 256，按原计划发送时间计延迟。容量耗尽才记录漏发，空闲工作线程处于调度间隙时仍可接收请求。每档退出码表示执行和证据状态，容量按协议原始指标判定。运行时观察会增加少量计数、文件采样和诊断事件开销，独立供给者仍需另行验证。

负载客户端的 `-target` 继续只接受显式回环地址。独立供给机可使用 `-private-target` 指向测试专用私网的目标 IP 和端口。HTTPS 还需要该目标的 `-ca`。预查和计时请求均绑定同一地址，报告记录所用模式。正式双机运行还需同时核验两端进程归属、封存包与语料摘要及资源记录。本机标记驱动的冷读和长时控制仍走原运行器。

`peak` 和 `proxy-peak` 以同一池完成 30 秒 2,000 QPS 预热及 60 秒 10,500 QPS 计时。两端各记录最多 4,096 条至少 20 ms 的慢请求及超额数量。客户端阈值从计划发车计起，并记录工作线程、写入、响应头、响应体和校验完成时间。Kestrel 阈值从运行时观察中间件计起，覆盖后续应用处理及响应写回，记录声明的响应长度。时间线同时给出供给漏发和 CLR 暂停，并统计慢区间与暂停是否交叉。聚合按各自完成时间分桶。两端可比较绝对时间窗；请求无额外关联标记，时段交叉不能确认因果。观察诊断单独执行，完整验收仍用冻结的矩阵与长测入口。

`supplier` 和 `proxy-supplier` 单独检查供给余量。两种入口复用同一个连接池完成 30 秒 2,000 QPS 预热和 60 秒 11,000 QPS 诊断。请求混合、内容校验、在途上限、期限及服务链与标准矩阵一致。诊断观察计划的 660,000 次请求能否全部完成并通过校验，保留每秒供给时间线和 Go 进程计数。容量验收沿用冻结的 10,500 QPS 档。

本机供给者调度诊断可在清除全局 `GOMAXPROCS` 后设置 `FSUSBLOG_PERF_SUPPLIER_PROCS`。运行器只为负载进程设置该值，Caddy 继续使用自身运行时默认设置。`environment.txt` 记录请求的配置，每档 `producerBefore` 和 `producerAfter` 记录 Go 进程的实际调度并发。诊断保留原有计划发送时间和完整失败分母。通过余量核验后，容量复测的各次拓扑和运行应使用同一供给者配置。

在 macOS 上安排专用时段，使用同一干净候选、fixture、拓扑、供电和 GC 配置分别跑有采样和无额外采样的诊断。有采样试验可在第二个终端等待对应运行目录的 `owner.txt` 出现 `readiness=204`，随即采集约 120 秒。下列命令将采样器自身的用时与错误另存，示例对应 `proxy-supplier` 的第二次运行。

```bash
(
  umask 077
  perf_run=artifacts/p2-tls-supplier-2
  perf_observer=artifacts/p2-tls-supplier-2-observer
  mkdir "$perf_observer" || exit 1
  until [[ -s "$perf_run/outcome.txt" ]] || grep -qx 'readiness=204' "$perf_run/owner.txt" 2>/dev/null; do
    sleep 0.2
  done
  [[ ! -s "$perf_run/outcome.txt" ]] || exit 1
  /usr/bin/time -p -o "$perf_observer/time.txt" sudo -n /usr/bin/powermetrics \
    -s tasks,cpu_power,thermal -i 200 -n 600 -b 1 -a 0 \
    > "$perf_observer/powermetrics.txt" 2> "$perf_observer/stderr.txt"
)
```

用两个报告的计时起止、进程 PID 和样本时间核对覆盖范围，并对比正确响应数、每秒漏发、最大唤醒和写入后等待时间及每条路由的延迟。200 ms 的采样可观察主机及进程 CPU 压力。需要查看更短的 runnable 延迟时，可在另一次诊断使用 `xcrun xctrace record --template 'System Trace' --all-processes --time-limit 120s --output artifacts/p2-tls-supplier-system.trace`，并单列跟踪开销。

用 `python3 tests/Performance/capacity.py --direct PATH --proxy PATH` 复算已完成矩阵的数字门槛。两种参数均可重复传入独立运行目录。脚本检查冻结档位、请求配比、每条路由的延迟、完整失败分母及清理记录，输出样本的最高档判定；同机供给余量和双次独立资格仍由验收记录确认。

在准备正式 900 秒运行前加 `--require-peak-quorum` 检查短档数字前置条件。直连和 TLS 必须各有至少两轮独立峰值通过，否则退出 1。标准输出保留全部传入矩阵的原始复算结果，包含失败轮次。独占运行和供给余量仍须由本次设备及链路证据确认。

### 独立供给结果准入

在数字复算命令加 `--private-supplier-inputs TRUSTED_INPUTS` 启用独立供给的短档准入。该目录由运行协调方保留，含实际封存包 `fsusblog-v2.tar.gz`、`payload.sha256`、使用的 `wire.schema.json` 和执行的 Go 二进制 `load`。验收只读取归档及原始报告。同机运行器目前不会产出该凭据。缺少凭据或原始输入时，准入退出非零。原命令仍可复算历史数字。

协调方先验证两台实机及独占资源，再通过现有受信控制通道交接本次地址、语料和 TLS CA。每轮保留现有 `outcome.txt`、`owner.txt`、`release-input.json`、`fixture.json` 和正式矩阵的其余记录。私网直连在 `owner.txt` 也需记录显式 `target`。TLS 则留下实际使用的公开 `ca.pem` 及代理进程归属，Kestrel 上游仍是回环。协调方在本轮证据目录独立保留 `private-supplier.json`，不得从移动后的报告反推运行归属。

- `version` 为 1。记录 `runId`、`invocationId`、`attemptId`、`topology`（direct/proxy）、`target`、预查的公开 `generation` 字符串，以及设备身份的稳定 `serverHostId` 和 `supplierHostId` SHA-256。设备身份来自现有运维记录。用同机上的 VM 或新用户名更名不会取得独立资源证明。
- 记录实际 `archiveSha256`、`payloadManifestSha256`、`fixtureSha256`、`wireSha256`、`toolSha256`、`ownerSha256`、`outcomeSha256` 和 `releaseInputSha256`。代理拓扑另记录 `caSha256`。直连的 `caSha256` 为 null。
- `stages` 按 2000、5000、8000、10500 排序，每项包含 `rate`、实际 `supplierPid`、`exitCode`、`reportSha256`、UTC `acceptedAt` 和 `collectedAt`。协调方在启动供给进程前查验自己的服务和数据库仍就绪并记下前者，收取报告时再复查并记下后者。两机 UTC 应校验同步，60 秒计时由供给端单调时钟记录。各档沿用原池预热 30 秒和 15 秒冷却。

校验把原始结果绑定到就绪、当前目标和归属区间，复算沿用原阈值。协调方还须根据双方的真实进程、CPU 和链路记录确认独占及供给余量。短档记录通过后，900 秒采样另需真实服务端标记围合供给进程的计时窗口。

`supplyBySecond` 使用计划起点及单调时钟分桶。计划数按原定桶记录，调度器唤醒、准入、漏发、完整 socket 写入、响应头、读完预期上限内的响应体、校验及尝试结束按各自发生时间记录。收尾可以延伸到计划窗口之外。历史字段 `sent` 仍为准入后的尝试数，包含连接或发送阶段失败。`socketWritten` 表示完整请求进入客户端连接，服务端收到多少仍须跟应用计数核对。观察到的在途峰值有并发采样误差，漏发时确认已达 256 个。每轮也留存负载进程的用户与系统 CPU、Go GC 暂停 CPU 时间与分配字节起止值。使用 `go test -race tests/Performance/{load,cold,load_test}.go` 验证取消收尾、分桶和连接读写计数。
