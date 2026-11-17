# 单机 Caddy TLS 部署

带作者章节标题搜索的发布包包含从旁边检出的 FsusUI 源码编译的本机 Markdown 解析器。用 `tools/build-release.sh` 在与部署环境兼容的系统和 CPU 架构上构建，构建机需要支持 C++23 的 C++ 编译器。`release.txt` 中的 `server_rid` 标记目标运行时。Linux 部署请使用对应 Linux 包，macOS 部署请使用对应 macOS 包。

Caddy 保留站点 `Host`，从实际 TLS 连接生成单跳转发头，并将完整 HTTP 响应交给浏览器。Kestrel 在同一受控主机监听 `127.0.0.1`。代理配置关闭响应缓存、明文 HTTP 入口和 Caddy 管理端口。

Caddy 到 Kestrel 使用 HTTP/1.1，最多保持 64 条上游连接，空闲连接 60 秒后关闭。上游不启用自动压缩。此配置用于限制负载突发时回环拨号数量；调整后须重新验证实际容量和写入行为。

公开图片启用后，Caddy 对 `/public-media` 独立匹配，保留 `no-store`，与公开页面共用上游池。启用可信回环代理时，Kestrel 先校验单跳转发的真实客户端地址，再对图片按每 IP 10 次/秒和额外 30 次突发配额准入，拒绝时返回 429 与 `Retry-After`。应用保留每 IP 每分钟 600 次的兜底限额。验证后的图片最多同时持有四份缓冲，代理模式的长 GET 先发送 1 MiB，后续由 Kestrel 按最高 8 MiB/s 逐段发送。Caddy 2.11.9 通过 `Incremental` 响应信号逐段转发。

为 Kestrel 设置 `FSUSBLOG_TRUST_LOOPBACK_PROXY=true`，在数据库和静态资源设置外指定 `--urls http://127.0.0.1:5080`。浏览器登录使用的 `FSUSBLOG_PASSKEY_ORIGIN` 必须匹配外部 HTTPS 来源，`FSUSBLOG_PASSKEY_RP_ID` 使用该来源的主机名。代理模式的健康检查访问 Caddy HTTPS 上的 `/health/ready`。回环地址处于同一操作系统信任边界，部署者须限制本机访问及 TLS 私钥权限。

为 Caddy 单独配置公开地址、监听地址、证书链与相应私钥。

```bash
export FSUSBLOG_PUBLIC_ADDRESS=https://blog.example.org
export FSUSBLOG_PROXY_BIND=0.0.0.0
export FSUSBLOG_UPSTREAM_PORT=5080
export FSUSBLOG_TLS_CERTIFICATE=/srv/fsusblog/tls/fullchain.pem
export FSUSBLOG_TLS_KEY=/srv/fsusblog/tls/privkey.pem
caddy validate --config deploy/Caddyfile --adapter caddyfile
caddy run --config deploy/Caddyfile --adapter caddyfile
```

证书由部署方更新并重启代理进程。测试使用按次生成的回环证书及独立 CA，通过同一 Caddyfile 验证代理、来源、Cookie 和会话。生产证书和外部网络仍需在实际部署验证。见[本机负载与代理入口](../tests/Performance/README.md)。

## 独立管理域名

启用管理员登录时使用 `Caddyfile.admin`。它从同目录的 `Caddyfile` 导入公开站点和回环上游规则。两个文件一起分发，单独使用 `Caddyfile` 仍可提供纯公开站点部署。

为 Caddy 追加管理域名和证书设置，给 Kestrel 设置匹配的管理来源和 RP ID。公开来源应与 `FSUSBLOG_PUBLIC_ADDRESS` 一致。每个证书必须覆盖对应主机的 SAN。也可以为两个主机指定同一份包含两者的证书链和密钥。

```bash
export FSUSBLOG_ADMIN_ADDRESS=https://manage.example.org
export FSUSBLOG_ADMIN_TLS_CERTIFICATE=/srv/fsusblog/admin-tls/fullchain.pem
export FSUSBLOG_ADMIN_TLS_KEY=/srv/fsusblog/admin-tls/privkey.pem
export FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.org
export FSUSBLOG_ADMIN_ORIGIN=https://manage.example.org
export FSUSBLOG_ADMIN_RP_ID=manage.example.org
caddy validate --config deploy/Caddyfile.admin --adapter caddyfile
caddy run --config deploy/Caddyfile.admin --adapter caddyfile
```

管理主机只向上游转发管理文档 `/admin`、`/admin/articles`、`/admin/interaction`、`/admin/site`、`/admin/system`、`/admin/identity`（含单个尾随斜杠），以及 `/api/v2/admin/identity/*`、`/assets/*` 和 `/dist/*`。管理主机要求 TLS SNI 与 HTTP Host 匹配。Caddy 按真实 TLS 请求重建转发头，站点账号和管理员凭据各自按主机与权限验证。管理员 Cookie 使用 `__Host-` 前缀，完成 Passkey 登录后才签发。域名、公网证书和网络接入策略需要部署方验证。 [Caddy 的 SNI 和 Host 说明](https://caddyserver.com/docs/caddyfile/options#strict-sni-host)

`tests/EndToEnd/run-admin-tls.sh` 使用两个独立的环回证书、原生 PostgreSQL 和 Chrome 虚拟 CTAP2 验证此配置。为脚本设置测试数据库连接 `FSUSBLOG_TEST_DB` 及配套的 `PGHOST`、`PGPORT`、`PGUSER`。可通过 `FSUSBLOG_NATIVE_SERVER_BUILD`、`FSUSBLOG_NATIVE_MIGRATE_BUILD` 和 `FSUSBLOG_WEB_DIST` 指向解包后的发布产物。测试只为子进程设置证书信任，结束后移除临时数据库、私钥和监听进程。 [Chrome 测试证书用法](https://github.com/GoogleChrome/samples/blob/gh-pages/webtransport/webtransport_server.py)

## 站点访问统计

管理员的「站点」页显示最近 30 个 UTC 日的访问量与最多 30 个地区，访问统计要求独立管理会话与 `audit.read`。这里只统计同源公开页面成功返回的 HTML GET（不是独立访客数，不含静态资源、API、后台、缓存命中的 304、站内只走前端路由的切换或本机/内网地址）。热度统计是另一套计量，两者不混算。旧版数据不会自动迁入。

默认关闭。在维护窗口通过对应版本的迁移程序运行 `site-traffic schema`，然后为服务设置 `FSUSBLOG_SITE_TRAFFIC=true` 和有效的 `FSUSBLOG_PUBLIC_ORIGIN`。代理部署继续沿用上文的可信单跳 Caddy 模式，按真正连接地址计量，不接受客户端自行提供的地区字段。可选的 `FSUSBLOG_SITE_TRAFFIC_REGIONS` 指向部署者提供的离线 JSON 前缀表（最多 1 MiB/4096 条，最长匹配优先），每条包含 `cidr` 和 `region`；地区格式为两位国家码或 ISO 地区扩展，例如 `CN-BJ`。未配置地区表时仍可统计访问量；已配置但未命中的地址归到「未知地区」。项目不自带地理数据库，也不会将地址发给外部查询服务。

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
