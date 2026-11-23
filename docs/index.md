# FsusBlog v2 文档总索引

> **角色**：文档总导航
> **适用对象**：部署者、站点管理员、贡献者与自动化 Agent
> **权威依据**：本页仅用于路由查找，不重复定义契约；文档分层与写作约束见 [文档架构与写作规范](development/documentation-policy.md)。

## 部署与运维

- [项目总览与快速开始](../README.md)
- [单域名 TLS 反代部署（Nginx / Caddy）](../deploy/README.md)
- [PostgreSQL 离线维护与备份恢复](migration.md)
- [单机数据库租约与交接](publication-lease.md)
- [站点能力默认开启与静默覆盖](product/site-capabilities.md)

## 协议、前端集成与验证

- [AEDS v2 二进制协议](protocol.md)
- [FsusUI 本地源码接入](fsusui.md)
- [Web 构建与端到端验证](web-validation.md)
- [本机公开读取负载与压测说明](../tests/Performance/README.md)
- [文档架构与写作规范](development/documentation-policy.md)

## 功能契约（按业务域分组）

### 公开阅读、搜索与分发

- [站点能力默认开启与静默覆盖](product/site-capabilities.md)
- [公开站点配置](product/public-site-configuration.md)
- [关于与站点政策](product/site-pages.md)
- [界面语言](product/interface-languages.md)
- [签名主题与字体](product/signed-appearance.md)
- [文章分类和标签](product/taxonomy.md)
- [本地全文检索](product/public-search.md)
- [公开 FAS4 服务端检索](product/fas4-search.md)
- [公开分发（RSS / Atom / JSON Feed / Sitemap）](product/distribution.md)
- [公开文章阅读统计](product/article-read-proof.md)
- [公开热门文章](product/public-hot-articles.md)
- [公开文章图片发布](product/public-article-media.md)

### 创作工作区、Canvas 与导出

- [文章工作区](product/article-workspace.md)
- [创作模块实现与验收边界](product/authoring-implementation.md)
- [作者文章列表与回收站](product/author-article-inventory.md)
- [作者全文搜索](product/author-full-text-search.md)
- [作者保存视图](product/author-saved-views.md)
- [文章属性](product/properties.md)
- [私有文章修订历史](product/article-revision-history.md)
- [文章发布沿革](product/article-publication-history.md)
- [文章定时发布](product/article-schedule.md)
- [私有资产库](product/private-media.md)
- [保存修订的 Markdown 与多格式导出](product/markdown-export.md)
- [Canvas 图形工作区](product/canvas-workspace.md)
- [Canvas 文章链接事务](product/canvas-transaction.md)
- [Canvas 可移植包](product/canvas-bundles.md)

### 社区互动与通知

- [公开评论读取与评论治理](product/comments.md)
- [站内信与私有通知](product/communication.md)
- [站点订阅偏好](product/subscription-preference.md)

### 身份认证、管理后台与扩展

- [Passkey 登录与首次绑定](product/passkey.md)
- [站点会话管理](product/site-sessions.md)
- [站点账号保持登录](product/site-persistent-refresh.md)
- [站点账号二次验证（TOTP MFA）](product/mfa.md)
- [站点账号 Recovery Key](product/site-recovery-key.md)
- [独立管理员身份与安全防护](product/admin-identity.md)
- [管理员分类与标签目录](product/admin-taxonomy.md)
- [管理员标签元数据](product/admin-tag-metadata.md)
- [管理员文章回滚与归档](product/admin-article-rollback.md)
- [创作扩展包与操作授权](product/extension-authority.md)
- [离线平台插件执行](product/platform-plugin-offline.md)

### 内容完整性与公开验签

- [公开验证密钥](product/integrity-keys.md)
- [发布权利快照、透明日志与日检查点](product/publication-rights.md)

## 历史归档（只读）

- [历史文档归档说明](archive/README.md)（包含 v1 基线与开放议题快照 `archive/v1-baseline/`、早期研发流水账 `archive/dev-logs/`）
