# 发布就绪矩阵

> **角色**：发布治理状态
> **适用对象**：发布负责人与核心维护者
> **权威依据**：本页概括当前 v2 主干的功能实现状态与正式发布前的退出边界；逐提交的历史验收流水账见 [执行状态归档](../archive/dev-logs/status.md) 与 [历史发布验收边界归档](../archive/dev-logs/release-readiness.md)。

V1 已退役。历史旧数据以只读归档保留，仓库已移除 V1 离线迁移工具；V1 旧运行链复刻、全量旧库导入与旧凭据延续不再作为 v2 发布门槛。最终正式发布需在同一冻结提交上完成目标平台复验、发布包校验与容量验收。

---

## 域级就绪状态

| 领域 | 当前已实现并覆盖的核心范围 | 正式发布前仍需收口的边界 | 主要验证入口 |
| --- | --- | --- | --- |
| **工程架构与数据层** | 7 个 .NET 10 工程分层（`Contracts`/`Core`/`Platform`/`Storage`/`Server`/`Cli`/`PluginWorker`）、统一 `01..04*.sql` Schema、只读启动准入、单机独占 PostgreSQL 租约、物理备库升主与 `pg_rewind` 演练、备份指纹与恢复核验 | 目标生产平台的密钥运维交接与外部仲裁/多节点编排规范 | `dotnet build FsusBlog.V2.slnx -c Release --no-restore`<br>`tests/Integration/Migration/verify.sh`<br>`tests/Integration/Migration/backup-candidate.sh`<br>`tests/Integration/Migration/physical-standby.sh` |
| **协议与搜索** | AEDS v2 二进制帧生成（C#/TS/C++ 同步）、Wasm 差分验证、本地 FSPK v4 分片 + IndexedDB 复用 + FSPT 增量补丁、宽语料暂存分片、零数据库查询的服务端 FAS4 及 `auto`/`local`/`server` 三模式 | C11 满档两项固定查询试词、百万篇在线查询门槛与跨档趋势复验 | `./tools/protocol-test.sh`<br>`tests/Integration/` 搜索套件 |
| **公开阅读与分发** | 首屏 HTML + 水合一致性、公开站点 SEO/合规配置及管理后台热覆写、静态站点页与在线编辑、RSS/Atom/JSON Feed、Sitemap、可见阅读证明计数、热门榜单、无追踪 30 日流量统计、显式公开图片与封面、签名外观主题与字体 | 公开附件网关完整预算复验、部分窄屏（320px）上游 FsusUI 布局跟进（如 FsusUI #1126） | `tests/EndToEnd/run-native.sh`<br>`tests/EndToEnd/run-admin-tls.sh` |
| **身份与安全模型** | 统一单域名默认架构（可选拆分独立管理域名或纯只读模式）、读者/管理员表与凭据及 Cookie 隔离、Passkey 注册/登录/多设备管理、TOTP MFA、Recovery Key、持久续期链、管理员 Passkey Step-Up、Scoped PoW、一键生成 CSPRNG 密钥与管理员引导 | 生产公网证书与真实外网拓扑验证；通用动态风险评分与强匿名运行时（按需单列范围） | `tests/EndToEnd/run-admin-tls.sh`<br>`tests/EndToEnd/run-native.sh` |
| **创作、属性与 Canvas** | 持久双栏工作区与快速切换、离线 IndexedDB 草稿日志恢复、文章库与回收站、定时发布、私有修订历史与比较、管理员回滚与归档再发布、八种封闭属性（千字段万篇实测）、保存视图、作者全文/章节/属性检索、万节点 Canvas 与可移植包、HTML/Markdown/DOCX/EPUB/PDF 异步与多图导出 | 富编辑器完整跨组状态与部分公开 Canvas 锚点上游依赖（FsusUI #1082/#1083）、完整无障碍读屏实测 | `tests/EndToEnd/run-native.sh`（各 `FSUSBLOG_TEST_FLOW`）<br>`tests/Integration/` 创作套件 |
| **社区评论与沟通** | 公开评论树与永久链接、受控登录投稿与直接回复（Classic PoW）、作者编辑/删除/申诉、双人独立申诉复核、批量审核、评论修订与审核时间线、举报去重、站内信/工单、WebSocket 实时推送、一次性订阅取消 | 外部邮件/订阅投递提供方集成、管理员全事件广播 | `tests/EndToEnd/run-inbox-native.sh`<br>`tests/EndToEnd/run-admin-tls.sh` |
| **完整性与离线扩展** | `/integrity/keys.json` 公开密钥清单、原生发布证明与权利快照、浏览器独立验签、透明日志头与外部锚定、systemd 独立只读账户每日 Merkle 检查点、macOS/Debian ARM64 离线签名纯 Markdown 插件宿主与作者端预览授权 | 生产定时器与外部独立时间见证落地；通用在线插件 Hook 与 IO broker | `tools/verify-publication-*.mjs`<br>`tests/Integration/Migration/extensions.sh`<br>`tests/Integration/Migration/linux-managed-plugin-flow.py` |
| **发布包与性能容量** | 锁定依赖框架依赖发布包（`tools/build-release.sh`）、SHA-256 清单与完整 Git bundle 验证、Debian ARM64 同包冷启动与重启一致性验证、900 秒堆硬上限长测零热读数据库调用 | **正式发布阻断项**：最终冻结提交需完成独立双实机供给的两轮直连 + 两轮 TLS 独占短档达标（错误+漏发 ≤ 0.1%）及随后的 900 秒正式长时验收；Docker 验收由外部目标环境执行并单列结果 | `tools/build-release.sh`<br>`python3 tools/verify-release.py`<br>`tests/Performance/run.sh` |

---

## 最终冻结发布的退出清单

发布候选打标前，必须在同一冻结提交上顺序核验并归档结果：

1. **静态与单元门禁**：`dotnet build FsusBlog.V2.slnx -c Release --no-restore`（0 警告 0 错误）、`Core.Tests`、`Platform.Tests`、`./tools/protocol-test.sh`、`pnpm --dir src/Web typecheck && pnpm --dir src/Web build`、`python3 tools/check-docs.py`。
2. **实库与浏览器闭环**：隔离 PostgreSQL 18 完整集成测试、CLI 迁移/备份/物理备库套件，以及桌面 + 移动（明暗主题）真实浏览器端到端回归。
3. **发布包完整性**：`tools/build-release.sh` 产出并独立核验 `SHA256SUMS`、`payload.sha256`、`history.bundle`（空裸库 `git fsck --full`）与目标 Linux/macOS 实机冷启动和重启一致。
4. **容量与长稳验收**：独立供给机完成短档双轮达标（`capacity.py --require-peak-quorum`）及 900 秒独占长测。
