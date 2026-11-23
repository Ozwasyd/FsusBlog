# Web 构建与端到端验证

> **角色**：前端开发与测试指南
> **适用对象**：前端与全栈维护者
> **权威依据**：本地 alias 配置见 [`src/Web/vite.config.ts`](../src/Web/vite.config.ts)，视觉与交互验收规则见 [`.agents/skills/fsusblog-design-conformance/SKILL.md`](../.agents/skills/fsusblog-design-conformance/SKILL.md)。

## 1. 离线恢复、类型检查与构建

前端依赖锁定于 `src/Web/pnpm-lock.yaml`（Node 24 / pnpm 10 / Playwright），通过本地源码 alias 直接消费相邻 `../FsusUI` 仓库与 Sass 主题（见 [FsusUI 本地源码接入](fsusui.md)）：

```sh
pnpm --dir src/Web install --offline --frozen-lockfile --ignore-scripts
pnpm --dir src/Web typecheck
pnpm --dir src/Web build
```

- `typecheck` 启用 Vue 严格模板检查，覆盖全部 `src/Web/` 源码、`src/Contracts/` TypeScript 协议客户端与真实 FsusUI 组件类型。
- 预构建的 FsusUI 原生 Wasm 可通过 `FSUSBLOG_FSUSUI_WASM_DIST` 指定（严格校验 `.native-artifact-fingerprint`）；缺资源或指纹不匹配时拒绝启动构建。

## 2. 一键隔离端到端浏览器套件

主入口 [`tests/EndToEnd/run-native.sh`](../tests/EndToEnd/run-native.sh) 自动创建独立 Unix socket PostgreSQL 18 临时数据库、执行 `FsusBlog.V2.Cli` 初始化、灌入确定性夹具、启动真实 `FsusBlog.V2.Server` 与本机 Chrome（Playwright 虚拟 CTAP2 Passkey），并在退出时核验进程、监听与临时目录彻底清理。

```bash
# 默认完整闭环（登录、草稿保存、CAS 冲突、发布、HTML/AEDS 一致性、本地搜索、撤回与登出）
bash tests/EndToEnd/run-native.sh

# 强制要求 FsusUI 原生 Markdown Wasm 渲染
FSUSBLOG_TEST_REQUIRE_NATIVE=1 bash tests/EndToEnd/run-native.sh
```

### 按业务流定向执行（`FSUSBLOG_TEST_FLOW`）

| `FSUSBLOG_TEST_FLOW` / 入口 | 覆盖场景与常用附加开关 |
| --- | --- |
| 默认（未设置） | 公开首屏与水合一致性、管理登录、草稿保存、CAS 冲突、发布、本地检索、撤回与登出 |
| `passkey` / `site-sessions` / `mfa` | 读者 Passkey 首次绑定/多设备增删改名（`FSUSBLOG_TEST_PASSKEY_REMOVE=1` / `REMOVE_CURRENT=1` / `RENAME=1`）、多会话管理与 TOTP MFA |
| `reader-registration` / `public-route-transition` | 读者自助注册（准则 + PoW + Passkey）与作者/管理端隔离；公开导航与登录注册切换（`FSUSBLOG_TEST_AUTH_TRANSITIONS=1`） |
| `article-library` / `property-history` | 编辑器文章库、快速切换、分页、焦点恢复及历史属性对比 |
| `property-inspector-scale` | 1,000 个属性定义分页遍历；附加 `FSUSBLOG_TEST_PROPERTY_ACCESSIBILITY=1` 复验 100%/150%/200% 缩放与明暗主题无障碍树 |
| `private-media` / `article-media` / `public-article-media` | 私有资产库、草稿附件与公开图片发布；可选附加 `FSUSBLOG_TEST_RESUMABLE_MEDIA=1`、`FSUSBLOG_DOCUMENT_EXPORT_TASKS=true`、`FSUSBLOG_TEST_MEDIA_WEBP=1` |
| `canvas-scale` | 10,000 节点 / 10,000 边 Canvas 渲染、挂载上限、断连重试与跨账号隔离 |
| `comment-author-delete` | 统一登录页双角色 Passkey 协同验证读者多会话删除评论与撤稿后删除 |
| `bash tests/EndToEnd/run-inbox-native.sh` | 读者站内信桌面与窄屏断线补读；设 `FSUSBLOG_TEST_INBOX_TLS=1` 走 Caddy HTTPS |
| `bash tests/EndToEnd/run-admin-tls.sh` | TLS 反代（Caddy）下的管理员 Passkey、工单实时流、评论审核/申诉/批量审核、读者账号治理（`FSUSBLOG_TEST_READER_GOVERNANCE=1`）、公开站点配置（`FSUSBLOG_TEST_PUBLIC_SITE_CONFIG=1`）、阅读证明（`FSUSBLOG_TEST_ARTICLE_READ_PROOF=1`）、订阅偏好（`FSUSBLOG_TEST_SUBSCRIPTION_PREFERENCE=1`）与签名外观（`FSUSBLOG_TEST_ADMIN_APPEARANCE=1`） |

### 独立调用单脚本（连接已有隔离环境）

```sh
FSUSBLOG_TEST_URL=http://127.0.0.1:5080 \
FSUSBLOG_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
FSUSBLOG_TEST_REQUIRE_NATIVE=1 \
node tests/EndToEnd/blog-flow.mjs
```

## 3. 已知上游界面跟进

- 320px 超窄屏下站点设置页长复选框标签的横向溢出跟进上游 [FsusUI #1126](https://github.com/Ozwasyd/FsusUI/issues/1126)，窄屏无溢出断言保持不降级。
