# 单域名 TLS 反代部署（Nginx / Caddy）

FsusBlog v2 默认采用**统一单域名架构**：公开站点（`/`、`/archive`、`/article/*`、`/login`、`/user/*`）与管理/创作后台（`/admin/*`、`/api/v2/admin/identity/*`、`/api/v2/authoring/*`、`/api/v2/media/*`）共用同一个 HTTPS 域名。

安全边界由多层纵深防御共同保障，无需维护第二套管理域名与证书：

- **严格 CSP 与 XSS 清洗**：服务端在所有响应上统一输出 `Content-Security-Policy`（`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`，公开内容经安全 Markdown 渲染器输出，禁止原始 HTML 与不安全 URL 协议。
- **身份与凭据隔离**：普通读者（`blog_user` / `passkey_credential` / `fsus-v2-session`）与管理员（`admin_principal` / `admin_passkey_credential` / `__Host-FsusAdminSession`）在数据库表、Passkey 凭据表、会话 Cookie 与会话接口（`/api/v2/identity/session.aeds` vs `/api/v2/admin/identity/session.aeds` & `/api/v2/authoring/session.aeds`）上完全隔离。
- **高危操作防护**：保留 `SameSite=Strict`、`HttpOnly`、`X-Fsus-Admin-Permission-Session` 防串响应头、45 秒一次性 Passkey 二次验证（Step-Up）、双人申诉复核与全写操作同源校验。

## 最小应用配置

带作者章节标题搜索的发布包包含从旁边检出的 FsusUI 源码编译的本机 Markdown 解析器。用 `tools/build-release.sh` 在与部署环境兼容的系统和 CPU 架构上构建，构建机需要支持 C++23 的 C++ 编译器。`release.txt` 中的 `server_rid` 标记目标运行时。Linux 部署请使用对应 Linux 包，macOS 部署请使用对应 macOS 包。

Kestrel 仅监听本机回环地址 `127.0.0.1:5080`，由同机 Nginx 或 Caddy 终结 TLS。最小单域名配置如下（未显式设置 `FSUSBLOG_PASSKEY_ORIGIN` / `FSUSBLOG_ADMIN_ORIGIN` 时，自动从 `FSUSBLOG_PUBLIC_ORIGIN` 推导对应的 Origin 与 RP ID）：

```bash
export FSUSBLOG_DB='Host=127.0.0.1;Port=5432;Username=fsusblog;Database=fsusblog'
export FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.org
export FSUSBLOG_DATA_DIR=/var/lib/fsusblog
export FSUSBLOG_WEB_DIST=/srv/fsusblog/web
export FSUSBLOG_TRUST_LOOPBACK_PROXY=true
dotnet /srv/fsusblog/server/FsusBlog.V2.Server.dll --urls http://127.0.0.1:5080
```

代理模式的健康检查访问 HTTPS 入口的 `/health/ready`。回环地址处于同一操作系统信任边界，部署者须限制本机访问及 TLS 私钥权限。

## Nginx 单域名部署（推荐）

参考随仓库和发布包分发的 [`deploy/nginx.conf.example`](nginx.conf.example)。将其复制到 `/etc/nginx/conf.d/fsusblog.conf`（或 `sites-available`），替换域名、证书路径和上游端口后执行：

```bash
nginx -t
systemctl reload nginx
```

配置中与 FsusBlog v2 运行时契约严格对应的关键项：

1. **单跳转发头（`LoopbackProxy` 强校验）**：必须使用 `proxy_set_header X-Forwarded-For $remote_addr;` 与 `proxy_set_header X-Forwarded-Proto https;` 并剥离客户端伪造的 `Forwarded`、`X-Original-*`、`X-Real-IP`。**切勿使用 `$proxy_add_x_forwarded_for`**，否则携带逗号的多跳链路会被 Kestrel fail-closed 拒绝（400）。
2. **保留原始 `Host` 与拒绝未知 SNI**：使用 `proxy_set_header Host $http_host;` 并在 `default_server` 配置 `ssl_reject_handshake on;`。
3. **关闭压缩与缓冲**：`gzip off;`、`proxy_cache off;`、`proxy_buffering off;`、`proxy_request_buffering off;`，避免压缩动态/AEDS 二进制帧，并保留 `/public-media` 的渐进流式限速发送与分片上传。
4. **WebSocket 与上传上限**：为 `/api/v2/notifications/inbox/wake` 和 `/api/v2/admin/identity/inbox/.../wake` 透传 `Upgrade`/`Connection` 与长读超时；常规命令帧限制 `client_max_body_size 3m;`，`/api/v2/media/` 单独放宽至 `21m`（匹配后端 20 MiB 图片上限）；`/api/v2/media/draft-preview` 关闭访问日志。
5. **不覆盖上游安全头**：`Strict-Transport-Security` 放在 `server` 级，且不在子 `location` 重复声明 `add_header`；不要改写或弱化 Kestrel 下发的 `Content-Security-Policy` 与 `Cache-Control`。
6. **可选管理入口网络层收紧**：如需进一步缩小暴露面，可在模板中取消注释对 `/admin`、`/api/v2/admin/`、`/api/v2/authoring/` 的 `allow <VPN/办公IP>; deny all;` 规则。

## Caddy 单域名部署

也可以直接使用同目录的 [`deploy/Caddyfile`](Caddyfile) 进行单域名 HTTPS 部署。Caddy 保留站点 `Host`，从实际 TLS 连接生成单跳转发头，使用 HTTP/1.1 最多保持 64 条上游连接（空闲 60 秒关闭），关闭上游自动压缩、响应缓存、明文 HTTP 入口和管理端口，并对 `/public-media` 保留 `no-store` 及通过 `Incremental` 信号逐段转发。

```bash
export FSUSBLOG_PUBLIC_ADDRESS=https://blog.example.org
export FSUSBLOG_PROXY_BIND=0.0.0.0
export FSUSBLOG_UPSTREAM_PORT=5080
export FSUSBLOG_TLS_CERTIFICATE=/srv/fsusblog/tls/fullchain.pem
export FSUSBLOG_TLS_KEY=/srv/fsusblog/tls/privkey.pem
caddy validate --config deploy/Caddyfile --adapter caddyfile
caddy run --config deploy/Caddyfile --adapter caddyfile
```

公开图片启用时，Kestrel 先校验单跳转发的真实客户端地址，再对图片按每 IP 10 次/秒和额外 30 次突发配额准入（拒绝时返回 429 与 `Retry-After`），并保留每 IP 每分钟 600 次的兜底限额；验证后的图片最多同时持有四份缓冲，代理模式的长 GET 先发送 1 MiB，后续按最高 8 MiB/s 逐段发送。证书由部署方更新并重启代理进程。见[本机负载与代理入口](../tests/Performance/README.md)。

## 可选：关闭后台或拆分独立管理域名

- **纯公开只读节点**：若希望在配置了 `FSUSBLOG_PUBLIC_ORIGIN` 的公开实例上完全关闭管理后台，显式设置 `FSUSBLOG_ADMIN_ORIGIN=""`。启动后所有 `/admin/*`、`/api/v2/admin/identity/*`、`/api/v2/authoring/*` 与 `/api/v2/media/*` 路由均 fail-closed 返回 404。
- **可选独立管理域名**：如果运维策略明确要求将管理后台拆分到独立子域（如 `https://manage.example.org`），可显式配置 `FSUSBLOG_ADMIN_ORIGIN=https://manage.example.org`（未指定 `FSUSBLOG_ADMIN_RP_ID` 时自动取主机名），Nginx 侧为其配置独立 `server` 块或使用 [`deploy/Caddyfile.admin`](Caddyfile.admin)。注意管理路由只接受与 `FSUSBLOG_ADMIN_ORIGIN` 完全匹配的 scheme、Host 和端口。

## 站点访问统计

管理员的「站点」页显示最近 30 个 UTC 日的访问量与最多 30 个地区，访问统计要求管理员会话。这里只统计同源公开页面成功返回的 HTML GET（不是独立访客数，不含静态资源、API、后台 `/admin/*`、缓存命中的 304、站内只走前端路由的切换或本机/内网地址）。热度统计是另一套计量，两者不混算。旧版数据不会自动迁入。

配置有效的 `FSUSBLOG_PUBLIC_ORIGIN` 后默认开启（可通过 `FSUSBLOG_SITE_TRAFFIC=false` 静默关闭）。代理部署沿用上文的可信单跳模式，按真正连接地址计量，不接受客户端自行提供的地区字段。可选的 `FSUSBLOG_SITE_TRAFFIC_REGIONS`（或 `FSUSBLOG_DATA_DIR/traffic-regions.json`）指向部署者提供的离线 JSON 前缀表（最多 1 MiB/4096 条，最长匹配优先），每条包含 `cidr` 和 `region`；地区格式为两位国家码或 ISO 地区扩展，例如 `CN-BJ`。未配置地区表时仍可统计访问量；已配置但未命中的地址归到「未知地区」。项目不自带地理数据库，也不会将地址发给外部查询服务。

数据库仅持久化日期、地区和访问次数，不记录每次访问或原始 IP。计数批量落库；正在运行的采集器按 UTC 清理 30 日窗口之前的汇总，停用或停服期间不会执行该清理。页面会区分未启用、未配置地区表、暂无数据和暂不可用，不用本机测试访问填充真实统计。

## 每日签发归档候选

Linux 发布包中的 `fsusblog-daily-checkpoint.service` 和 `fsusblog-daily-checkpoint.timer` 示例以独立账户 `fsusblog-checkpoint` 每天在 UTC 00:05 签发前一天。部署者需按本机的账户和工具路径调整服务，提供只读 PostgreSQL 主库连接、独立留存的可信账本锚点和与文章签名密钥分离的专用密钥。以下是仅供服务管理器读取的 `/etc/fsusblog/checkpoint.env` 示例。

```ini
FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.org
FSUSBLOG_DB="Host=pg-primary.example.org;Database=fsusblog;Username=checkpoint_reader"
FSUSBLOG_CHECKPOINT_KEYS=/etc/fsusblog/checkpoint-keys.json
FSUSBLOG_CHECKPOINT_ANCHOR_SEQUENCE=123
FSUSBLOG_CHECKPOINT_ANCHOR_SHA256=<independently-retained-lowercase-sha256>
IntegrityProof__CheckpointSigning__KeyId=checkpoint
IntegrityProof__CheckpointSigning__PrivateKeyFile=/etc/fsusblog/checkpoint-private/key.pkcs8
```

为专用数据库账号授予目标库的 `CONNECT`、`public` schema 的 `USAGE` 和以下读取权限。

```sql
GRANT SELECT ON public.v2_schema, public.publication_transparency_head, public.publication_proof_key,
    public.article_publication_transparency, public.article_publication_proof,
    public.article_publication_canonical TO checkpoint_reader;
GRANT SELECT (id, processed_at) ON public.blog_outbox TO checkpoint_reader;
```

将两个单元安装到 `/etc/systemd/system/` 后运行 `systemctl daemon-reload` 和 `systemctl enable --now fsusblog-daily-checkpoint.timer`。单元自动为该账户创建仅自己可访问的 `/var/lib/fsusblog-checkpoints`。用 `journalctl -u fsusblog-daily-checkpoint.service` 检查退出状态、归档摘要和锚点。停机恢复时定时器补触发一次，指定失败或遗漏的具体日期时以同一签名账户运行带 `YYYY-MM-DD` 参数的命令。分发归档时按公开归档流程独立核验后，将已批准文件及摘要交给站点部署配置。 [签发与验签](../docs/product/publication-rights.md)
