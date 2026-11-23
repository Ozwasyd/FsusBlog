# 安全策略

> **角色**：安全披露与边界声明
> **适用对象**：安全研究者、站点部署者与维护者
> **权威依据**：部署信任边界以 [单域名 TLS 反代部署](deploy/README.md) 与 [运行与部署配置参考](docs/reference/configuration.md) 为准。

## 漏洞报告方式

**请勿在公开 Issue、Pull Request、讨论区或截图中披露未修复的安全漏洞。**

如果你在 FsusBlog v2 中发现潜在安全问题（包括但不限于认证绕过、跨角色越权、XSS/CSP 绕过、AEDS 协议解析越界、反代来源伪造、路径穿越、签名校验缺陷或密钥泄露风险），请通过 GitHub 仓库的 **Private Vulnerability Reporting**（`Security` → `Advisories` → `Report a vulnerability`）提交私密报告。

报告中请尽量提供：

1. 受影响的提交哈希或发布包 `SHA256SUMS`；
2. 最小复现步骤、触发配置（环境变量 / 反代拓扑）及预期与实际行为；
3. 潜在影响范围与可能的修复思路（如有）。

## 受保护范围

- **当前维护分支**：本仓库 `main` 分支及后续发布的 FsusBlog v2 正式版本。
- **已退役版本**：FsusBlog v1 已归档退役，不再接受功能更新或迁移工具修复。

## 核心安全不变量

部署或二次开发 FsusBlog v2 时，必须保持以下 fail-closed 安全边界：

- **在线与离线隔离**：`FsusBlog.V2.Server` 仅以 DML-only 数据库账号运行并只读校验 Schema；DDL 初始化、密钥生成、管理员 Passkey 引导/轮换/吊销与每日检查点签发仅由离线 `FsusBlog.V2.Cli` 执行。
- **严格身份隔离**：普通读者与管理员在数据库表、Passkey 凭据表、会话 Cookie（`fsus-v2-session` vs `__Host-FsusAdminSession`）与会话接口上完全分离。
- **规范来源与单跳代理**：通过 `FSUSBLOG_PUBLIC_ORIGIN` 锁定站点来源；反代必须配置单跳 `X-Forwarded-For`（如 Nginx 的 `$remote_addr`）并剥离客户端伪造头，切勿透传多跳链路或放宽上游 CSP/Cookie 头。
- **高危操作防护**：关键管理写操作受 45 秒一次性 Passkey Step-Up、作用域绑定 PoW、同源检查与双人申诉复核保护；所有安全密钥必须通过 CSPRNG（如 `FsusBlog.V2.Cli init-secrets`）独立生成，绝不复用弱默认值。
- **隔离运行边界**：离线插件预览、PDF 渲染与公开/私有媒体存储必须配置独立且互斥的 `0700` 目录，拒绝符号链接和跨目录引用。

更详细的安全架构说明请参阅 [系统架构总览](docs/architecture/overview.md) 与 [独立管理员身份](docs/product/admin-identity.md)。
