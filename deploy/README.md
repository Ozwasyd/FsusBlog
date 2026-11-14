# 单机 Caddy TLS 部署

Caddy 保留站点 `Host`，从实际 TLS 连接生成单跳转发头，并将完整 HTTP 响应交给浏览器。Kestrel 在同一受控主机监听 `127.0.0.1`。代理配置关闭响应缓存、明文 HTTP 入口和 Caddy 管理端口。

Caddy 到 Kestrel 使用 HTTP/1.1，最多保持 64 条上游连接，空闲连接 60 秒后关闭。上游不启用自动压缩。此配置用于限制负载突发时回环拨号数量；调整后须重新验证实际容量和写入行为。

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
