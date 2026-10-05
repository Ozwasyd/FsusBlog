# WIP: uncommitted migration terminal work

历史快照，未授合并、producer绑定、native验收或issue关闭资格。

- 原分支：`codex/issue-2214-terminal-current`
- 原 HEAD：`d653afbde02b75814d8384777886b10419fb38a1`
- 8文件真实工作树字节快照：`21991fd158ee2fd53ae8b62c3cb1e236756f7f0a`
- 原staged为空，7 tracked修改与1新测试均unstaged；原index/工作树/分支未改，改动仍在本机。
- 两个 artifacts/schema-migration JSON是原producer输出的现有WIP，未手改/重生成/自签资格；继续时须原producer与来源/receipt配套验证。
- 本次只保存源码与WIP；未运行SDK、测试、数据库、浏览器或CI，不可直接merge。
- 继续时核对 #2214 原条件、最新master、源代码与生成输出绑定、MigrationProviderExecutionTests及完整matrix/indep门禁。

## 已保存文件及原工作树 SHA-256

- `artifacts/schema-migration/migration-assembly-binding.json` — `0e2e4c2363c626b5af152e3152689d82cc59ea08c36f4eecfe7c312e926e8781`
- `artifacts/schema-migration/migration-assembly-receipt.json` — `9663484118cb27da2985c1762b505e3ba269b4f95fc18df90d0c5e2b54dc61eb`
- `docs/database-migration.md` — `57320865b7918c79af5fc2258e0e4060ed5f698b6ccdbefb4f36fab32ff5b857`
- `tests/migration/FsusBlog.Migration.Tests.csproj` — `deafdea9b55e1bf47bc5674d03f8483fe307504d64aeaf70ef76ba48714c4c40`
- `tests/migration/packages.lock.json` — `94ae401481cbb194a8da650a9f739e57a362767b64e9c33dbd782288fe5222af`
- `tests/tools/migration-terminal-governance.test.mjs` — `957b45d3ee423ac67639ba7acd32e18fbe72b10503c038d083069af00e0147b8`
- `tools/db/check-migration-terminal-governance.mjs` — `902f2379f5f0d94f266966d099f1bcaf2e160ec07c9c1848288112807848372a`
- `tests/migration/MigrationProviderExecutionTests.cs` — `416c652e8d4efb4a29eb6b431842ea1a6a9358774a863bc9c0b4da4d160c16b6`

