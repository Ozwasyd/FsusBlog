# 站点能力默认开启与静默覆盖

服务端由单一能力解析器 [`SiteCapabilities`](../../src/Server/Operations/SiteCapabilities.cs) 在启动时统一决定所有成熟能力的开关状态。所有无需额外外部依赖或高危密钥的能力均默认开启；需要域名、HTTPS、管理员来源或持久化目录作为安全前提的能力，在满足前提后自动激活；所有能力均保留 `FSUSBLOG_*=false` 或空字符串的显式静默关闭路径，且关闭后维持严格 fail-closed（路由不挂载、响应头报告禁用、页面不输出能力标记）。

## 最小部署配置

典型单域名生产部署只需配置数据库、单一 HTTPS 来源与统一数据目录即可自动开启全部内置能力（含读者与管理员 Passkey、在线站点页编辑与签名外观切换），无需维护第二套管理域名，也无需手动逐一填写 `RP_ID` 或功能开关：

```sh
FSUSBLOG_DB='Host=127.0.0.1;Port=5432;Username=fsusblog;Database=fsusblog'
FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.com
FSUSBLOG_DATA_DIR=/var/lib/fsusblog
```

- **单源自动推导**：未设置 `FSUSBLOG_PASSKEY_ORIGIN` 或 `FSUSBLOG_ADMIN_ORIGIN` 时，均自动复用 `FSUSBLOG_PUBLIC_ORIGIN`；未设置 `FSUSBLOG_PASSKEY_RP_ID` 或 `FSUSBLOG_ADMIN_RP_ID` 时，自动取对应 Origin 的规范化主机名（`IdnHost`）。显式设置 `FSUSBLOG_PASSKEY_ORIGIN=""` 可静默关闭站点 Passkey（同时自动关闭依赖它的读者注册与持久续期）；显式设置 `FSUSBLOG_ADMIN_ORIGIN=""` 可静默关闭全部管理后台与创作入口（纯公开只读节点）；显式设置 `FSUSBLOG_ADMIN_ORIGIN=https://admin.example.com` 仍可选拆分独立管理域名。显式提供不匹配的 `RP_ID` 仍会在启动时立即失败。
- **统一数据目录 `FSUSBLOG_DATA_DIR`**：要求绝对路径且与 `FSUSBLOG_WEB_DIST` 严格隔离。启动时自动创建 `0700` 权限的 `private-media/` 与 `public-media/` 子目录，并按需静默发现可选资产：
  - `site-pages/` 同时包含 `about.md`、`privacy.md`、`guidelines.md`、`copyright.md` 时自动启用静态站点页及在线编辑器（HTTPS 来源下）；
  - `appearance/appearance.json` 存在时自动加载签名外观注册表及在线切换（HTTPS 来源下）；
  - `traffic-regions.json` 存在时自动启用离线流量区域统计。
  - 单独配置 `FSUSBLOG_PRIVATE_MEDIA_ROOT`、`FSUSBLOG_PUBLIC_MEDIA_ROOT`、`FSUSBLOG_SITE_PAGES`、`FSUSBLOG_APPEARANCE_ROOT` 或 `FSUSBLOG_SITE_TRAFFIC_REGIONS` 会覆盖对应子路径；显式设为空字符串 `""` 可在启用 `FSUSBLOG_DATA_DIR` 时单独关闭该项。
- **安全密钥一键生成**：TOTP、Recovery Key 与订阅 HMAC 密钥绝不内置弱默认值，可通过离线 CSPRNG 命令一次性生成 256-bit 随机十六进制密钥：

```sh
dotnet FsusBlog.V2.Cli.dll init-secrets
```

- **两角色统一身份模型**：系统仅存在两种身份——普通用户 `User`（`blog_user` + `user_session` + `fsus-v2-session` + `/api/v2/identity/session.aeds`，用于评论与站内信）和唯一统一管理员 `Admin`（`admin_principal` + `admin_session` + `__Host-FsusAdminSession` + `/api/v2/admin/identity/session.aeds` / `/api/v2/authoring/session.aeds`，集成创作、评论审核、站内信处理与站点/系统配置全部能力，不再区分多类管理员子权限）。通过单条命令即可创建完整管理员并输出一次性 Passkey 引导密钥：

```sh
dotnet FsusBlog.V2.Cli.dll admin-identity bootstrap HANDLE
```

## 能力默认矩阵

| 类别 | 能力与静默覆盖环境变量 | 默认行为 |
| --- | --- | --- |
| 无条件默认开启 | 公开评论提交 `FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS`、登录评论回复 `FSUSBLOG_SIGNED_IN_COMMENT_REPLIES`、私有站内信写入 `FSUSBLOG_PRIVATE_INBOX_WRITES`、异步文档导出 `FSUSBLOG_DOCUMENT_EXPORT_TASKS`、公开热门文章 `FSUSBLOG_PUBLIC_HOT_ARTICLES`、宽语料分段搜索 `FSUSBLOG_WIDE_SEARCH_CORPUS`、公开搜索模式 `FSUSBLOG_PUBLIC_SEARCH_MODE`（默认 `auto`） | 启动即启用；显式设为 `false`（或搜索模式设为 `local`/`server`）时静默覆盖 |
| 依赖公开 HTTPS 源自动开启 | 站点 Passkey、读者自助注册 `FSUSBLOG_READER_REGISTRATION`、持久会话续期 `FSUSBLOG_SITE_PERSISTENT_REFRESH`、阅读证明计数 `FSUSBLOG_ARTICLE_READ_PROOF`、无追踪站点流量统计 `FSUSBLOG_SITE_TRAFFIC` | 配置 `FSUSBLOG_PUBLIC_ORIGIN` 后自动启用；未配置时静默保持关闭；显式 `=true` 但缺少前提时启动即报错 |
| 依赖管理员源自动开启 | 管理员站内信回复/状态/通知/共享已读/实时推送/活动排序（`FSUSBLOG_ADMIN_INBOX_*`）、评论批量审核 `FSUSBLOG_ADMIN_COMMENT_BATCH`；HTTPS 管理员源额外自动开启已发布文章回滚 `FSUSBLOG_ADMIN_ARTICLE_ROLLBACK`、标签与分类元数据 `FSUSBLOG_ADMIN_TAG_METADATA` / `FSUSBLOG_ADMIN_CATEGORY_METADATA` | 默认从 `FSUSBLOG_PUBLIC_ORIGIN` 自动推导（或通过 `FSUSBLOG_ADMIN_ORIGIN` 显式覆盖）并按协议安全级别自动启用；显式 `FSUSBLOG_ADMIN_ORIGIN=""` 关闭全部后台；单项 `=false` 可逐项关闭；显式 `=true` 但缺少 HTTPS 来源时启动即报错 |
| 依赖数据目录与资产自动开启 | 私有媒体分片续传 `FSUSBLOG_PRIVATE_MEDIA_RESUMABLE`、站点页在线编辑 `FSUSBLOG_SITE_PAGE_EDITOR`、签名外观在线激活 `FSUSBLOG_APPEARANCE_ACTIVATION` | 目录或必需基线文件就绪后自动激活；显式 `=false` 或目录项置空 `""` 时静默关闭 |
| 外部信任边界与密钥（保持显式） | `FSUSBLOG_TRUST_LOOPBACK_PROXY`、`FSUSBLOG_TOTP_KEY_HEX`、`FSUSBLOG_RECOVERY_KEY_PEPPER_HEX`、`FSUSBLOG_SUBSCRIPTION_HMAC_KEY`、`FSUSBLOG_PDF_TOOL_ROOT` / `FSUSBLOG_PDF_TOOL_SHA256`、`FSUSBLOG_PLATFORM_PLUGIN_ROOT` / `FSUSBLOG_AUTHOR_PLUGIN_PREVIEW_ID`、`FSUSBLOG_RUNTIME_EVIDENCE_*` | 保持显式 opt-in，绝不自动放宽信任边界或使用弱默认密钥 |

## 界面渐进披露原则

默认开启后端能力不增加首屏视觉噪音，界面控件只在当前上下文真正需要时出现：

- 首页热门文章模块仅在已存在已验证阅读记录（`hotArticles.length > 0`）时渲染；
- 搜索排序切换（相关度 / 最新发布）仅在匹配文章数 `> 1` 时渲染，单结果或空结果不展示多余排序栏；
- 搜索分页栏仅在结果超出单页或处于后续页时渲染；
- 管理后台文章工作区的「已发布回滚」标签仅在 HTTPS 管理员源启用回滚能力时展示；
- 创作工作区的异步导出面板默认折叠，PDF 格式仅在配置受检沙箱工具链时出现。
