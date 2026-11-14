# 签名主题与字体

v2 站点可以在部署时选择签名的主题和字体。功能默认关闭，关闭时使用 FsusUI 随发布包提供的样式。用于管理 Passkey 的独立管理员页面继续使用内置样式。

将 `FSUSBLOG_APPEARANCE_ROOT` 设为主机受信运维账号提供的绝对路径。目录应为 `0700`，文件为 `0400`，路径须解析到非符号链接的实际位置。它需要与静态发布目录及作者媒体目录分开。服务启动时只读该目录，分别验证已批准来源、原始归档摘要、ECDSA P1363 SHA-256 签名、公钥信任期限和声明的内容。错误配置或损坏归档会使启动失败。服务不会解压到磁盘，也不会装载包内程序。运维通过更换完整的只读目录并重启来发布或撤除外观。

`appearance.json` 采用严格 JSON。`Keys` 和 `Sources` 使用离线创作扩展的同一信任字段，但此处属性名按 C# 名称大小写书写，例如 `Publisher`、`KeyId`、`SubjectPublicKeyInfo`、`ValidFrom`、`ValidUntil`、`RevokedAt`、`Reference`、`Provenance`、`ArchiveSha256`、`SignatureReference`、`TrustPolicyReference`。来源目录和签名公钥由运维独立审核。`Packages` 最多 16 项，每项填写 `Source`、`ArchiveSha256` 和 `SignatureSha256`，文件名分别为 `<archive-sha256>.zip` 和 `<signature-sha256>.signature`。哈希使用小写十六进制。为 `ActiveTheme` 和 `ActiveFont` 填写经过验证的包 ID，或者填 `null` 保持相应内置值。 [离线创作扩展信任字段](extension-authority.md)

每个包必须含有 `manifest.json`，其中 `Format` 为 1。还需指定 `Kind`、`Id`、`Version`、`Publisher`、`SignatureReference` 和 `TrustPolicyReference`。

- `Kind` 为 `theme` 时，归档中只有清单。`Theme` 含 `LightAccent`、`LightHover`、`DarkAccent`、`DarkHover`，均为 `#` 和六位十六进制。程序验证与现有 FsusUI 页面底色的 4.5:1 对比度，并根据固定模板生成 FsusUI 主色及悬浮 token。
- `Kind` 为 `font` 时，归档中还含 `font.woff2` 和 `LICENSE.txt`。`Font` 含 `License`、`FontSha256` 和 `LicenseSha256`。支持 `OFL-1.1` 和 `Apache-2.0` 声明，运维负责审核实际授权。WOFF2 限 1 MiB 和单字体，程序限制容器声明的解压大小并检查两个文件的摘要。CSS 用固定字族名和同源哈希路径注册 400 常规字重，其他字符由 FsusUI 字体回退。除字体与许可证以外的资源会被拒绝。

启用后，HTML 只链接由服务器生成的同源样式表。公开接口只输出配置选中的 CSS 和 WOFF2，路径绑定实际响应的 SHA-256，响应 `no-store`。任一启用包的信任期限结束或发现时钟回退会停止提供本次部署的外观资源。新打开的页面恢复内置外观。已经载入的浏览器标签需重新加载才能恢复。

固定 v1 的 `ThemeAdminEndpoints` 和 `FontAdminEndpoints` 注册了受管理员权限保护的只读 AEDS 登记与启用视图。v1 `.fstheme` 和 `.fsfont` 有不同的清单、资源和应用配置。当前 v2 格式提供部署启用，后续仍需 v1 包迁移、在线管理员界面、数据库启用历史与更完整的 FsusUI 扩展审查。
