# 签名主题与字体

v2 站点可以在部署时选择签名的主题和字体。未配置签名目录时使用 FsusUI 随发布包提供的样式。用于管理 Passkey 的独立管理员页面继续使用内置样式。

将 `FSUSBLOG_APPEARANCE_ROOT` 设为主机受信运维账号提供的绝对路径。目录应为 `0700`，文件为 `0400`，路径须解析到非符号链接的实际位置。它需要与静态发布目录及作者媒体目录分开。服务启动时只读该目录，分别验证已批准来源、原始归档摘要、ECDSA P1363 SHA-256 签名、公钥信任期限和声明的内容。错误配置或损坏归档会使启动失败。服务不会解压到磁盘，也不会装载包内程序。运维通过更换完整的只读目录并重启来发布或撤除外观。

`appearance.json` 采用严格 JSON。`Keys` 和 `Sources` 使用离线创作扩展的同一信任字段，但此处属性名按 C# 名称大小写书写，例如 `Publisher`、`KeyId`、`SubjectPublicKeyInfo`、`ValidFrom`、`ValidUntil`、`RevokedAt`、`Reference`、`Provenance`、`ArchiveSha256`、`SignatureReference`、`TrustPolicyReference`。来源目录和签名公钥由运维独立审核。`Packages` 最多 16 项，每项填写 `Source`、`ArchiveSha256` 和 `SignatureSha256`，文件名分别为 `<archive-sha256>.zip` 和 `<signature-sha256>.signature`。哈希使用小写十六进制。为 `ActiveTheme` 和 `ActiveFont` 填写经过验证的包 ID，或者填 `null` 保持相应内置值。 [离线创作扩展信任字段](extension-authority.md)

每个包必须含有 `manifest.json`，其中 `Format` 为 1。还需指定 `Kind`、`Id`、`Version`、`Publisher`、`SignatureReference` 和 `TrustPolicyReference`。

- `Kind` 为 `theme` 时，归档中只有清单。`Theme` 含 `LightAccent`、`LightHover`、`DarkAccent`、`DarkHover`，均为 `#` 和六位十六进制。程序验证与现有 FsusUI 页面底色的 4.5:1 对比度，并根据固定模板生成 FsusUI 主色及悬浮 token。
- `Kind` 为 `font` 时，归档中还含 `font.woff2` 和 `LICENSE.txt`。`Font` 含 `License`、`FontSha256` 和 `LicenseSha256`。支持 `OFL-1.1` 和 `Apache-2.0` 声明，运维负责审核实际授权。WOFF2 限 1 MiB 和单字体，程序限制容器声明的解压大小并检查两个文件的摘要。CSS 用固定字族名和同源哈希路径注册 400 常规字重，其他字符由 FsusUI 字体回退。除字体与许可证以外的资源会被拒绝。

迁移 v1 字体时，可在该登记项加入 `"Format": "fsfont-v1"` 并存放 `<archive-sha256>.fsfont`。保留原始 ZIP 字节，使用运维独立批准的发布者公钥和该 ZIP 的 ECDSA P1363 SHA-256 签名。包内的 `source` 是许可证来源信息，发布者信任仍由外部 `Keys` 和 `Sources` 决定。迁移读取固定 v1 的小驼峰清单、`license/LICENSE.txt`、与清单来源精确一致的 `license/source.json`，以及清单声明的一个直属 `fonts/` 的 WOFF2。包的 `fsusblog` 比较范围须包含参考版 1.3.0。

此格式支持 `ui-sans`、400 常规字重、`font-display: swap`、`OFL-1.1` 和 `Apache-2.0`。可选 Unicode 范围使用普通十六进制端点及逗号列表，例如 `U+0000-00FF`，经验证后逐字保留到样式。请求其他字重、字型、脚本/地区限制、critical、preload、defer、其他字体角色或附加资源的包会被拒绝。旧包继续使用同一 v2 FsusUI 字体栈、当前启用版本检查和原始归档摘要。 [固定 v1 包格式](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/fonts/fsfont-package.md) · [固定 v1 清单](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/fonts/font-manifest.schema.json)

启用后，HTML 只链接由服务器生成的同源样式表。公开接口只输出配置选中的 CSS 和 WOFF2，路径绑定实际响应的 SHA-256，响应 `no-store`。任一启用包的信任期限结束或发现时钟回退会停止提供本次部署的外观资源。新打开的页面恢复内置外观。已经载入的浏览器标签需重新加载才能恢复。

在线启用可在停服运行 `appearance schema` 后通过 `FSUSBLOG_APPEARANCE_ACTIVATION=true` 开启。新库由 `apply` 安装对应表结构。开关要求配置签名目录和两套独立 HTTPS 来源。初始版本 0 读取部署文件中的主题与字体。拥有独立 `system.config` 权限的管理员可以在 **Site appearance** 查看可用签名包、选择主题和字体或恢复上一组配置。每次保存绑定当前版本、当前包摘要、指定的下一组包摘要和回滚动作，并要求管理员 Passkey 用户验证和一次性 PoW。版本冲突返回 409。事务递增版本并记录管理员、时间、回滚标记和包摘要。只有仍受信的原始归档可以恢复。管理员选择仅修改数据库。

启用此模式时，公开 HTML 链接同源 `/site-appearance/current.css`，该路径转向当前版本及字节 SHA-256 对应的样式。字体路径同样包含启用版本和字节摘要。新的启用或回滚均使用新的版本。过期的路径返回 404，即使当前包的内容曾在该版本启用。样式和字体响应设为 `no-store` 和 `Cross-Origin-Resource-Policy: same-origin`，请求用一秒预算取得当前版本并在响应前释放数据库事务。已经获准的响应可以传完，浏览器已加载的样式在重载后更新。密钥到期、检测到时钟回退或部署者更新撤销并重启时，站点恢复内置外观。发布者密钥撤销由运维更新独立批准材料。关闭在线开关后，重启恢复使用部署选定的主题和字体，数据库启用记录保留。

固定 v1 的 `ThemeAdminEndpoints` 和 `FontAdminEndpoints` 注册了受 `system.config` 保护的 5 个及 3 个只读 AEDS 路由。v1 `ThemeLifecycleService` 核对原包后执行启用、停用和回滚。v2 在线管理使用独立的 `/api/v2/admin/identity/appearance*` AEDS 路由，公开 FsusUI 自动根据浅色和深色状态选择已核验 token。v1 主题启用、通用 `.fsfont` 加载计划、管理响应及独立启用作用域仍待迁移。 [v1 主题端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/ThemeAdminEndpoints.cs) · [v1 字体端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/FontAdminEndpoints.cs) · [v1 主题生命周期](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Themes/ThemeLifecycleService.cs)

## 离线检查 v1 主题包

```sh
dotnet FsusBlogV2.Migrate.dll extension inspect-fstheme /private/operator/trust.json \
  approved-source/minimal-ink /private/review/minimal-ink.fstheme /private/review/minimal-ink.signature
```

信任文件使用 `extension init` 的小驼峰 JSON 格式。运维独立批准原始 ZIP 的 SHA-256 和当前可信的发布者公钥，签名采用原 ZIP 的 ECDSA P1363 SHA-256。私有信任目录及文件权限分别是 `0700` 和 `0400`。此命令只需三个输入文件和批准来源名称，无需数据库、扩展存储或其 MAC 密钥。 [信任字段](extension-authority.md)

成功输出一份 `inspection-only` JSON，包含原档摘要、来源、发布者、主题标识、兼容范围、包声明的模式及能力、配置字段、样式与资源的归档内路径、各条目的长度和 SHA-256。入口采用 v1 的 16 MiB 压缩、8 MiB 解压、128 条目上限，并检查通用五个必需文件、规范路径、声明引用、实际字节预算、v1.3 版本和闭合配置结构。检查子集要求完整的能力及权限字段，路径限于规范 ASCII 字符。非法签名或结构以错误码退出。 [固定 v1 包格式](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/themes/package-format.md)

预览仅记录原字节长度和摘要。固定 v1 Minimal Ink 夹具只有四个 PNG 起始字节，也能执行结构检查。该命令不做图像解码、CSS 安全认证、配置应用、提取、安装或启用，也不会把归档加入 FsusUI 运行时。v1 的 `--fsus-color-action-primary-bg` 指按钮底色。现有 v2 `--fsus-color-action-primary` 是 FsusUI 的强调色入口，两者不能直接映射。 [固定 v1 夹具](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/backend/Unit/ThemeInfrastructureTests.cs#L871) · [固定 v1 token 规范](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/themes/token-schema.md)

构建迁移工具后，可用 `python3 tests/Integration/Migration/legacy-theme-inspect.py "$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll"` 复现。测试按固定 v1 夹具重新打包实际 ZIP、签名并核对原档和条目摘要，同时检查未知来源、签名篡改、密钥撤销及非法包结构。
