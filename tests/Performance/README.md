# P2 公开读取负载

负载口径和全量验收预算在 [P2 验收和负载协议](../../docs/product/p2-acceptance.md)。本目录可以重复运行原生 PostgreSQL 和 Kestrel 的直连采样。

```bash
# 在仓库根目录执行，先从锁文件离线恢复 src/Web 的依赖和 FsusUI 构建输入。
export DOTNET_BIN=/absolute/path/to/dotnet
export PG_TOOLS_DIR=/absolute/path/to/postgresql/bin
mkdir -p artifacts
tests/Performance/run.sh smoke artifacts/p2-smoke-1
tests/Performance/run.sh direct artifacts/p2-direct-1
tests/Performance/run.sh cold artifacts/p2-cold-1
export CADDY_BIN=/absolute/path/to/caddy
tests/Performance/run.sh proxy-smoke artifacts/p2-proxy-smoke-1
tests/Performance/run.sh proxy artifacts/p2-proxy-1
```

- `smoke` 用完整数据集和 3 秒 100 QPS 验证接入。`direct` 依次做 30 秒预热和 60 秒采样的 2,000、5,000、8,000、10,500 QPS 档位。`soak` 做 30 秒预热和 15 分钟 8,000 QPS 采样。跨运行比较时留出足够主机容量，避免同时启动编译器、浏览器测试或其他负载。
- 运行器使用原生 `initdb` 按次创建私有 Unix socket 数据库，在快照源目录中恢复构建并验证，执行当前迁移 CLI 的 plan、apply 和 verify，再以事务导入固定语料。语料包含 12,000 篇常规公开文章、50 篇草稿、50 篇用于撤回测试的预先发布文章、32 个分类和 128 个标签。生产 DSN 不参与运行。启动后的真正 Kestrel 自动获取回环端口。
- Go 标准库驱动固定 20/30/20/30 四类 GET 请求，最多 256 个活动连接，2 秒端到端期限，HTTP/1.1 keep-alive 和 identity 编码。每档预查全部 2,402 个 URL，用源语料检查发布代次、正文、记录位置、AEDS CRC、分类和标签。计时期间检查完整长度、HTTP 状态、类型和代次，并定期计算校验和。首页 AEDS 游标会随时间刷新，校验和只对其游标字符作归一化，仍验证 AEDS CRC 和游标边界。
- `outcome.txt` 记录运行、调用、尝试标识和退出状态。`environment.txt`、`owner.txt`、`source-status.txt`、`*.sha256`、`fixture.json` 与 `commands.txt` 将候选源、构建、锁文件、数据、运行身份及命令关联起来。每档 JSON 分路由提供已发、漏发、正确响应、状态、错误、计时分位和发车延迟。`server-process.csv` 保存采样的服务端 RSS 和 CPU。退出时验证并移除本次私有 PostgreSQL、Kestrel 和临时目录，证据目录保留。

- `cold` 运行四轮，每轮在 64 个已连接的 HTTP 客户端上同时释放请求。前三轮各选一个不同大小的未驻留键，HTML 与 AEDS 各 32 次。最后一轮使用 64 个不同的 32 KiB 公开键。按 fixture 创建日期排除热键，关闭热预查，并在私有服务日志中查验首次准入、实际渲染次数、最大并发、队列排空以及客户响应。正常语料要求 256 个正确 200 响应。诊断记录包含本次运行观测到的错误和服务器取消数。64 个不同键用于检查并发上限，不能覆盖超过 64 个键后的拒绝路径。

代理入口使用交付的 [Caddyfile](../../deploy/Caddyfile) 和每轮独立生成且按次信任的 TLS CA，证书校验包含回环 IP。代理负载和直连使用相同的供给档位及 HTTP/1.1 identity。运行记录包含 TLS 版本、配置、进程归属及 RSS，并检查裸后端拒绝、转发头重建、Passkey 来源和真实会话 Cookie。结束时检查 Caddy 与 Kestrel 的监听均已关闭，并清理本轮证书和数据库。

当前运行器的客户端和服务端共用主机。调度器把已排队和已发出请求一起限制在 256，按原计划发送时间计延迟。容量耗尽才记录漏发，空闲工作线程处于调度间隙时仍可接收请求。每档退出码表示执行和证据状态，容量按协议原始指标判定。独立供给者、数据库访问归因和 GC 指标仍需另行验证。
