# 运行与部署配置参考

> **角色**：权威配置参考
> **适用对象**：站点部署者、系统管理员与维护者
> **权威依据**：运行时能力解析以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 与各功能模块源码为准，并由 `python3 tools/check-docs.py` 校验源码中的运行时 `FSUSBLOG_*` 覆盖完整性。

FsusBlog v2 遵循 **fail-closed** 原则：无效布尔值、非法枚举、不匹配的 `RP_ID`、路径重叠或缺失必要安全前提时，服务在启动阶段即拒绝运行，绝不静默降级为不安全默认配置。

---

## 最小部署配置示例

```bash
export FSUSBLOG_DB='Host=127.0.0.1;Port=5432;Username=fsusblog;Database=fsusblog'
export FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.org
export FSUSBLOG_DATA_DIR=/var/lib/fsusblog
export FSUSBLOG_WEB_DIST=/srv/fsusblog/web
export FSUSBLOG_TRUST_LOOPBACK_PROXY=true
```

满足上述 5 项后，服务自动推导 Passkey 与管理员 Origin/RP ID，自动在 `FSUSBLOG_DATA_DIR` 下创建 `0700` 权限的 `private-media/` 与 `public-media/`，并自动启用所有无额外高危密钥依赖的成熟能力。详见 [站点能力默认开启与静默覆盖](../product/site-capabilities.md) 与 [单域名 TLS 反代部署](../../deploy/README.md)。

---

## 1. 核心运行与网络入口

| 变量名 | 适用组件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FSUSBLOG_DB` | Server / Cli | **必填** | 含显式数据库名的 PostgreSQL Npgsql 连接串。Server 应使用 DML-only 账号；Cli 使用独立维护/DDL 账号 |
| `FSUSBLOG_PUBLIC_ORIGIN` | Server / Cli | 未设置 | 站点唯一规范公开来源（如 `https://blog.example.org`）。决定 canonical URL、Feed/Sitemap、单源自动推导的 Passkey 与管理员 Origin，以及 HTTPS 依赖能力 |
| `FSUSBLOG_DATA_DIR` | Server | 未设置 | 统一持久化数据根目录（须为绝对路径且与 `FSUSBLOG_WEB_DIST` 互斥）。自动初始化 `private-media/`、`public-media/`，并按需发现 `site-pages/`、`appearance/appearance.json`、`traffic-regions.json` |
| `FSUSBLOG_WEB_DIST` | Server | 进程默认目录 | 已构建前端静态产物目录（包含 `index.html` 与 `assets/`），部署发布包时指向解包后的 `web/` |
| `FSUSBLOG_TRUST_LOOPBACK_PROXY` | Server | `false` | 显式启用单跳可信回环反代模式（Nginx / Caddy）。启用后校验单跳 `X-Forwarded-For`/`X-Forwarded-Proto`，拒绝伪造头与多跳链路 |
| `FSUSBLOG_NODE_ID` | Server | 空（不暴露主机名） | 管理后台「服务与版本」面板展示的节点标识（最多 64 位 ASCII 字母、数字、`.`、`-`、`_`） |

---

## 2. 身份、Passkey 与安全密钥

> 密钥类配置绝无弱默认值；可使用 `dotnet FsusBlog.V2.Cli.dll init-secrets` 一次性生成三组独立 256-bit 十六进制随机密钥。

| 变量名 | 适用组件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FSUSBLOG_PASSKEY_ORIGIN` | Server | 推导自 `FSUSBLOG_PUBLIC_ORIGIN` | 读者 Passkey Relying Party Origin；显式设为 `""` 可静默关闭站点 Passkey（同步关闭读者注册与持久续期） |
| `FSUSBLOG_PASSKEY_RP_ID` | Server | 推导自 `FSUSBLOG_PASSKEY_ORIGIN` 主机名 | 读者 Passkey RP ID；显式提供不匹配主机名时启动即报错 |
| `FSUSBLOG_ADMIN_ORIGIN` | Server | 推导自 `FSUSBLOG_PUBLIC_ORIGIN` | 管理员与创作后台 Origin。显式设为 `""` 关闭全部后台与创作入口（纯公开只读节点）；也可设为独立管理域名（如 `https://manage.example.org`） |
| `FSUSBLOG_ADMIN_RP_ID` | Server | 推导自 `FSUSBLOG_ADMIN_ORIGIN` 主机名 | 管理员 Passkey RP ID；显式提供不匹配主机名时启动即报错 |
| `FSUSBLOG_TOTP_KEY_HEX` | Server | 未设置（关闭 TOTP） | 64 位十六进制（32 字节）专用密钥，用于加密存储站点账号 TOTP 密钥 |
| `FSUSBLOG_RECOVERY_KEY_PEPPER_HEX` | Server | 未设置（关闭 Recovery Key） | 64 位十六进制（32 字节）专用密钥，用于站点账号恢复密钥派生；不得与 `FSUSBLOG_TOTP_KEY_HEX` 相同 |
| `FSUSBLOG_SUBSCRIPTION_HMAC_KEY` | Server / Cli | 未设置（关闭订阅偏好） | 订阅取消签名证明专用 HMAC 密钥（需同时配置有效 `FSUSBLOG_PUBLIC_ORIGIN`） |
| `FSUSBLOG_READER_REGISTRATION` | Server | 启用站点 Passkey 时自动为 `true` | 控制读者自助注册开关；显式 `=false` 关闭；显式 `=true` 但无 Passkey 时启动报错 |
| `FSUSBLOG_SITE_PERSISTENT_REFRESH` | Server | 启用站点 Passkey 时自动为 `true` | 控制站点账号持久登录续期链；显式 `=false` 关闭；显式 `=true` 但无 Passkey 时启动报错 |

---

## 3. 站点能力开关与默认覆盖

所有布尔覆盖仅接受 `true` 或 `false`（忽略大小写与首尾空白），非法值导致启动失败。

### 3.1 公开与互动能力

| 变量名 | 默认行为 | 依赖前提 / 说明 |
| --- | --- | --- |
| `FSUSBLOG_PUBLIC_SEARCH_MODE` | `server` | 公开搜索模式：`server`（默认，零库查询服务端 `/api/v2/public/search.aeds`，不下载全量语料或启动 Worker）、`auto`（显式 opt-in：紧凑分片 → 宽语料 → 服务端）、`local`（显式 opt-in：仅客户端分片，仍需网络 `HEAD` 代次复核，非离线搜索） |
| `FSUSBLOG_LOCAL_SEARCH_CORPUS` | `true` | 启用紧凑档 FSPK v4 本地语料分片构建与 `/api/v2/public/search-corpus` 端点；纯服务端搜索部署可显式设为 `false` 以完全跳过本地语料构建与内存占用（端点返回 `404` 并保持重启确定性的 `PublicGeneration`；与 `FSUSBLOG_PUBLIC_SEARCH_MODE=local` 互斥，启动即失败） |
| `FSUSBLOG_WIDE_SEARCH_CORPUS` | `true` | 启用 25,601–100,000 篇文章的大语料暂存分片构建与宽档 HTTP 端点 |
| `FSUSBLOG_PUBLIC_HOT_ARTICLES` | `true` | 启用公开热门文章榜单（热读零数据库查询） |
| `FSUSBLOG_ARTICLE_READ_PROOF` | 配置公开源后为 `true` | 启用文章可见阅读计时证明计数；显式 `=true` 需有效 `FSUSBLOG_PUBLIC_ORIGIN` |
| `FSUSBLOG_SITE_TRAFFIC` | 配置 HTTPS 公开源后为 `true` | 启用最近 30 UTC 日无追踪页面访问采集与统计；本机 Loopback 管理源默认仅开放已入库聚合只读预览（不启用 HTTP 采集）；显式 `=false` 同时关闭采集与读取；显式 `=true` 需 HTTPS `FSUSBLOG_PUBLIC_ORIGIN` |
| `FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS` | `true` | 启用受控登录评论投稿（Classic PoW + 审核队列） |
| `FSUSBLOG_SIGNED_IN_COMMENT_REPLIES` | `true`（受评论投稿约束） | 启用登录账号直接回复与审核后站内通知（需同时开启评论投稿） |
| `FSUSBLOG_PRIVATE_INBOX_WRITES` | `true` | 启用普通账号站内信/工单写入 |
| `FSUSBLOG_DOCUMENT_EXPORT_TASKS` | `true` | 启用异步多格式文档导出后台任务（HTML / Markdown / DOCX / EPUB，PDF 另见第 6 节） |
| `FSUSBLOG_PRIVATE_MEDIA_RESUMABLE` | 私有媒体就绪后为 `true` | 启用私有媒体分片续传上传（需私有媒体目录就绪） |
| `FSUSBLOG_APPEARANCE_ACTIVATION` | 外观注册表与管理源就绪后为 `true` | 启用签名主题与字体的管理后台在线切换 |

### 3.2 管理后台子能力

以下开关均依赖已激活管理员源（自动推导或显式 `FSUSBLOG_ADMIN_ORIGIN`）；显式设 `FSUSBLOG_ADMIN_ORIGIN=""` 会一次性关闭全部管理入口，也可按单项 `=false` 静默关闭：

| 变量名 | 默认行为 | 说明 |
| --- | --- | --- |
| `FSUSBLOG_ADMIN_INBOX_REPLIES` | 管理员源就绪后为 `true` | 管理员在后台回复站内工单 |
| `FSUSBLOG_ADMIN_INBOX_STATUS` | 管理员源就绪后为 `true` | 管理员更新工单状态 |
| `FSUSBLOG_ADMIN_INBOX_NOTICE` | 管理员源就绪后为 `true` | 管理员内部工单注记 |
| `FSUSBLOG_ADMIN_INBOX_SHARED_READ` | 管理员源就绪后为 `true` | 管理员共享已读水位 |
| `FSUSBLOG_ADMIN_INBOX_LIVE` | 管理员源就绪后为 `true` | 管理端工单/队列 WebSocket 实时唤醒与补读 |
| `FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER` | 管理员源就绪后为 `true` | 按最新活动排序收件箱队列 |
| `FSUSBLOG_ADMIN_COMMENT_BATCH` | 管理员源就绪后为 `true` | 待审评论批量领取、批准与驳回 |
| `FSUSBLOG_ADMIN_ARTICLE_ROLLBACK` | 管理员源就绪后为 `true` | 管理员回滚已发布文章或归档再发布 |
| `FSUSBLOG_ADMIN_TAG_METADATA` | 管理员源就绪后为 `true` | 管理员编辑标签元数据 |
| `FSUSBLOG_ADMIN_CATEGORY_METADATA` | 管理员源就绪后为 `true` | 管理员编辑分类元数据 |
| `FSUSBLOG_SITE_CONFIG_EDITOR` | HTTPS 公开+管理源或本机 Loopback 管理源就绪后为 `true` | 管理后台在线覆写公开 SEO/合规元数据；设为 `false` 回退至环境变量只读基线 |
| `FSUSBLOG_SITE_PAGE_EDITOR` | 同上（且站点页目录就绪） | 管理后台在线编辑 `about` / `privacy` / `guidelines` / `copyright` 站点页 |

---

## 4. 存储路径覆盖与构建期资产

单独设置以下路径可覆盖 `FSUSBLOG_DATA_DIR` 的自动子路径发现；显式设为空字符串 `""` 可在启用 `FSUSBLOG_DATA_DIR` 时单独关闭该子项。

| 变量名 | 适用组件 | 说明 |
| --- | --- | --- |
| `FSUSBLOG_PRIVATE_MEDIA_ROOT` | Server | 私有资产库独立根目录（绝对路径、`0700`、与 Web/公开媒体/外观目录互斥） |
| `FSUSBLOG_PUBLIC_MEDIA_ROOT` | Server | 公开文章图片独立对象根（绝对路径、`0700`、需同时启用私有媒体目录） |
| `FSUSBLOG_SITE_PAGES` | Server | 静态站点页目录（需含 `about.md`、`privacy.md`、`guidelines.md`、`copyright.md`） |
| `FSUSBLOG_APPEARANCE_ROOT` | Server / Cli | 签名外观注册表目录（需含 `appearance.json`） |
| `FSUSBLOG_SITE_TRAFFIC_REGIONS` | Server | 离线 CIDR 地区映射 JSON 文件路径（最多 1 MiB / 4,096 条，最长前缀匹配） |

---

## 5. 公开 SEO 与合规元数据（环境变量基线）

通过 ASP.NET Core 分层配置键注入修订 `0` 的只读基线（支持在线管理覆写时由数据库覆盖，详见 [公开站点配置](../product/public-site-configuration.md)）：

| 配置前缀 | 主要子键 | 说明 |
| --- | --- | --- |
| `FSUSBLOG_PUBLIC_SEO`（如 `FSUSBLOG_PUBLIC_SEO__Title`） | `Title`、`Description`、`Author`、`OgImage`、`FaviconSvgUrl`、`FaviconIcoUrl`、`FaviconPngUrl`、`AppleTouchIconUrl`、`ManifestName`、`ManifestShortName`、`PwaIcon192Url`、`PwaIcon512Url`、`PwaMaskableIconUrl`、`ThemeColor`、`BackgroundColor`、`SiteLogoUrl`、`SiteLogoDarkUrl`、`SiteWordmarkUrl` | 预编码进 SEO AEDS 帧、公开 HTML 头部与 `/manifest.webmanifest` |
| `FSUSBLOG_PUBLIC_COMPLIANCE`（如 `FSUSBLOG_PUBLIC_COMPLIANCE__Enabled`） | `Enabled`、`RegionMode`（`global` / `mainland-cn`）、`CopyrightStartYear`、`CopyrightOwner`、`CopyrightText`、`ContentLicenseName`、`ContentLicenseUrl`、`IcpRecordNumber`、`IcpRecordUrl`、`PoliceRecordNumber`、`PoliceRecordUrl`、`PoliceBadgeIconUrl`、`OperatorName`、`ContactEmail` | 预编码进合规 AEDS 帧与页脚合规披露 |

---

## 6. 扩展、离线插件与 PDF 导出工具链

| 变量名 | 适用组件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FSUSBLOG_PDF_TOOL_ROOT` | Server | 未设置（禁用 PDF 导出） | 受控离线 PDF 渲染工具链目录（需与 `FSUSBLOG_PDF_TOOL_SHA256` 配对） |
| `FSUSBLOG_PDF_TOOL_SHA256` | Server | 未设置 | 固定校验的 PDF 工具链清单/归档 SHA-256 摘要 |
| `FSUSBLOG_PLATFORM_PLUGIN_ROOT` | Server / Cli | 未设置 | 已签名并批准的本地纯 Markdown 平台插件注册表目录（须为绝对路径） |
| `FSUSBLOG_PLATFORM_PLUGIN_LINUX` | Server / Cli / Platform | 未设置 | Linux ARM64 上设为 `1` 显式启用托管插件隔离 Worker（`PluginWorker`） |
| `FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256` | Server / Cli / Platform | 未设置 | 校验 `/opt/fsusblog-platform-plugin-arm64` 安装完整性的 SHA-256 摘要 |
| `FSUSBLOG_AUTHOR_PLUGIN_PREVIEW_ID` | Server | 未设置 | 启用同源 HTTPS 作者端签名插件预览时允许的唯一插件 ID（需搭配上述 Linux 隔离 Worker 与注册表） |
| `FSUSBLOG_EXTENSION_ROOT` | Cli (`extension`) | 未设置 | 离线签名创作扩展包存储根目录 |
| `FSUSBLOG_EXTENSION_STORE_ID` | Cli (`extension`) | 未设置 | 离线扩展存储绑定标识 |
| `FSUSBLOG_EXTENSION_MAC_KEY_FILE` | Cli (`extension`) | 未设置 | 离线扩展存储完整度认证 MAC 密钥文件路径 |

> 注：`FSUSBLOG_PURE_PLUGIN_WORKER` 为 CLI 与 Linux 启动器拉起隔离插件子进程时注入的内部进程守卫标记，不属于部署配置项。

---

## 7. 完整性签名与每日检查点

### 7.1 ASP.NET Core `IntegrityProof` 配置节（环境变量使用 `__`）

| 配置路径 | 适用组件 | 说明 |
| --- | --- | --- |
| `IntegrityProof__Signing__CurrentKeyId` | Server / Cli | 当前生效的发布签名密钥 ID |
| `IntegrityProof__Signing__Keys__<id>__PublicKey` | Server | Base64url 编码的 ECDSA P-256 DER SPKI 公钥（最多 64 项，公布于 `/integrity/keys.json`） |
| `IntegrityProof__Signing__Keys__<id>__Algorithm` | Server | 签名算法（`ECDSA_P256_SHA256`） |
| `IntegrityProof__Signing__Keys__<id>__Version` / `NotBeforeUtc` / `NotAfterUtc` / `RevokedAtUtc` / `CompromisedAtUtc` | Server | 公钥版本与生命周期状态时间 |
| `IntegrityProof__Signing__NativeV2Enabled` | Server | 设为 `true` 启用原生 v2 发布证明签名 |
| `IntegrityProof__Signing__NativeV2PrivateKeyFile` | Server / Cli | 站点文章发布签名私钥路径（PKCS#8，与 Web 目录隔离） |
| `IntegrityProof__Signing__NativeV2PublicHeadAnchor` | Server | 外部锚定的透明日志头校验坐标 |
| `IntegrityProof__CheckpointSigning__KeyId` / `PrivateKeyFile` | Cli | 每日检查点专用签名密钥 ID 与独立私钥路径（须与文章签名私钥分离） |
| `IntegrityProof__CheckpointArchive__Enabled` / `Path` / `Sha256` / `CurrentAnchor` | Server | 公开分发已批准日检查点归档的开关、路径、固定摘要与锚点 |
| `IntegrityProof__HistoricalV1__KeysSha256` / `CheckpointSha256` | Server | 只读校验历史 v1 归档证明时的固定公钥集与检查点摘要 |

### 7.2 Systemd 每日检查点服务变量（[`deploy/fsusblog-daily-checkpoint.service`](../../deploy/fsusblog-daily-checkpoint.service)）

| 变量名 | 说明 |
| --- | --- |
| `FSUSBLOG_CHECKPOINT_KEYS` | 独立受控的检查点公钥清单 JSON 路径 |
| `FSUSBLOG_CHECKPOINT_ANCHOR_SEQUENCE` | 外部留存的可信透明日志锚点序号 |
| `FSUSBLOG_CHECKPOINT_ANCHOR_SHA256` | 外部留存的可信透明日志锚点小写 SHA-256 摘要 |

---

## 8. 反向代理部署变量（Caddy 模板）

适用于 [`deploy/Caddyfile`](../../deploy/Caddyfile) 与可选拆分管理域名的 [`deploy/Caddyfile.admin`](../../deploy/Caddyfile.admin)（Nginx 模板 [`deploy/nginx.conf.example`](../../deploy/nginx.conf.example) 直接修改配置文件）：

| 变量名 | 说明 |
| --- | --- |
| `FSUSBLOG_PUBLIC_ADDRESS` | Caddy 公开站点监听地址（如 `https://blog.example.org`） |
| `FSUSBLOG_PROXY_BIND` | Caddy 绑定网卡地址（如 `0.0.0.0`） |
| `FSUSBLOG_UPSTREAM_PORT` | 本机回环 Kestrel 上游端口（如 `5080`） |
| `FSUSBLOG_TLS_CERTIFICATE` / `FSUSBLOG_TLS_KEY` | 公开站点 TLS 证书链与私钥路径 |
| `FSUSBLOG_ADMIN_ADDRESS` | 可选独立管理域名地址（如 `https://manage.example.org`，仅 `Caddyfile.admin`） |
| `FSUSBLOG_ADMIN_TLS_CERTIFICATE` / `FSUSBLOG_ADMIN_TLS_KEY` | 可选独立管理域名的 TLS 证书链与私钥路径 |

---

## 9. 运行时诊断与运维脚本变量

| 变量名 | 适用组件 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `FSUSBLOG_RUNTIME_EVIDENCE_CONTROL` | Server | 未设置（关闭） | 性能/长时压测专用控制目录；配置后启用低开销运行时采样器 |
| `FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT` | Server | 未设置 | 启用 `FSUSBLOG_RUNTIME_EVIDENCE_CONTROL` 时必填的诊断结果输出路径 |
| `FSUSBLOG_RUNTIME_SLOW_REQUESTS` | Server | `false` | 启用运行时诊断时记录超过 20 ms 阈值的慢请求分段 |
| `FSUSBLOG_CLI_DLL` | `tools/site-backup.py` 等脚本 | 默认构建输出 | 显式定位已发布的 `FsusBlog.V2.Cli.dll` 路径 |
| `DOTNET_BIN` | `tools/build-release.sh` / 运维脚本 | `PATH` 中的 `dotnet` | 指定锁定的 .NET 10 SDK 可执行文件路径 |
