# #1146 Acceptance 轻量化交接

原 35 个 route/auth/user/admin/public Acceptance 场景已经按错误发现边界拆分：31 个场景迁移到 Router、mounted component、生产 API adapter、HTTP renderer 或隔离 PostgreSQL integration；仅 4 个真实 hydration/navigation 场景保留在 serial Browser Contract。权威逐条记录是 `tests/issue-1146-acceptance-baseline.json` 与 `tests/issue-1146-retention-replacements.json`，中央 retention 链同步在 `tests/test-retention-replacements.json`。

| 责任层 | 当前覆盖 |
|---|---|
| Router | route/path/name 唯一性、anonymous/user/admin、permission、guestOnly、redirect、403/404、AOT defer、deep link |
| Vue component | loading/error/empty/success、表单启用与 inline error、dialog、message list/compose/thread、mobile navigation、aria-current、admin dashboard |
| API/backend | 生产 AEDS adapter、工单持久化与 notification/cache、评论审核事务、文章发布 fence/rights/outbox、账号 ban/cache |
| HTTP/renderer | SEO/head/SSR、search noindex、404、canonical redirect、CSP nonce、social image |
| Browser Contract | #1147 将 4 个 public browser risk 合并为 1 个 hydration/history/reload 场景，并与 auth/write/PWA 组成 5 个基线场景；step-up-ready immutable fixture 再加入第 6 个 WebAuthn 成功场景 |

浏览器测试不得直接调用 child process、Docker、SQL 或 Redis，也不得在 desktop/mobile 循环中重复真实写入。`auth-flows.spec.ts`、`user-console.spec.ts`、`admin-console.spec.ts` 和无有效 WebAuthn 合同的 `debug-passkey.spec.ts` 均不属于当前浏览器面。

## 聚焦验证

```bash
npm --prefix src/frontend run check:acceptance:auth
npm --prefix src/frontend run check:acceptance:console
node --test tests/tools/acceptance-layer-migration.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --filter FullyQualifiedName~MessageCenterPersistenceIntegrationTests
```

真实浏览器仅在 release-final 或需要验证浏览器边界时运行：

```bash
npm --prefix src/frontend run check:browser-contract
```

回退不需要恢复重型 route/CRUD 穷举：轻量测试失败时在对应层修复；Browser Contract 失败时可暂停该浏览器合同并保留 Router/API/backend correctness 门禁，不重启或修改生产服务语义。
