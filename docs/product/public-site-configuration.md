# 公开站点配置

部署者通过 ASP.NET Core 配置设置公开元数据。环境变量使用下面的双下划线写法，或在部署配置中使用同名节。服务启动时验证并冻结配置。变更在下一次服务启动生效。

```sh
FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.com
FSUSBLOG_PUBLIC_SEO__Title='North Journal'
FSUSBLOG_PUBLIC_SEO__Description='Notes on fieldwork'
FSUSBLOG_PUBLIC_SEO__Author='North Journal editors'
FSUSBLOG_PUBLIC_SEO__ThemeColor='#123456'
FSUSBLOG_PUBLIC_COMPLIANCE__Enabled=true
FSUSBLOG_PUBLIC_COMPLIANCE__RegionMode=global
FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightOwner='North Journal'
FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightStartYear=2024
FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseName='CC BY 4.0'
FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseUrl=https://creativecommons.org/licenses/by/4.0/
```

`GET` 和 `HEAD /api/binary/system/seo` 与 `/api/binary/system/compliance` 保留 v1 AEDS 帧 13 与 26 的字段位置、固定长度 UTF-8 区域，以及带长度前缀的变长文本区。匿名读取直接返回启动时预编码的数据。唯一站点地址是 `FSUSBLOG_PUBLIC_ORIGIN`，同时用于 SEO 帧的 `BaseUrl`、首屏 canonical、RSS/Atom/JSON Feed 和 Sitemap。未配置时 SEO 的 `BaseUrl` 为空，页面仍可使用站点默认名称和描述。请求 Host 和代理域名不参与配置选择。

SEO 节还接受 `OgImage`、`FaviconSvgUrl`、`FaviconIcoUrl`、`FaviconPngUrl`、`AppleTouchIconUrl`、`ManifestName`、`ManifestShortName`、`PwaIcon192Url`、`PwaIcon512Url`、`PwaMaskableIconUrl`、`BackgroundColor`、`SiteLogoUrl`、`SiteLogoDarkUrl` 和 `SiteWordmarkUrl`。颜色使用六位十六进制值。图片字段可指定无查询和片段的 HTTPS URL 或静态 `/assets/` 文件路径。公开 HTML 接入标题、描述、作者、主题色、社交图片、favicon、`<link rel="manifest" href="/manifest.webmanifest">` 以及已配置的页头 Logo/字标（加载失败时自动回退文本标题）。`GET` 和 `HEAD /manifest.webmanifest` 按当前生效的 SEO 配置返回 `application/manifest+json; charset=utf-8`（`Cache-Control: no-store`）。

合规节还接受 `CopyrightText`、`IcpRecordNumber`、`IcpRecordUrl`、`PoliceRecordNumber`、`PoliceRecordUrl`、`PoliceBadgeIconUrl`、`OperatorName`、`ContactEmail`。配置到本节的值会由匿名 AEDS 读取公开。`Enabled` 和 `RegionMode` 控制页脚的展示，与帧可见性无关。`Enabled=true` 时使用合规文本，`RegionMode=mainland-cn` 时展示已配置的备案项目与公安备案徽标。备案号码可使用随产品定义的官方链接，许可链接需配合许可名。安装密钥、数据库配置、登录/管理品牌和遗留 SEO keywords 不进入该输出。外部网址内容和已配置资源路径由部署者提供。

固定 v1 SEO 和合规 POD 分别为 5,000 和 1,709 字节，随后是四字节 blob 长度和文本。协议样本按冻结的字段顺序独立打包，C# 编码做整帧字节比对，TypeScript 做字段与错误边界验证。参考 [v1 二进制路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.System.cs)、[v1 POD](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/shared/Contracts/Models/SystemPods.cs)和[v1 编解码](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/core/Cache/PodBinaryCodec.System.cs)。

## 在线管理覆写与热刷新

当配置了 HTTPS 管理员源与公开源（或本机 Loopback 管理员源）时，管理后台「站点」工作区默认启用在线站点配置编辑器（可通过 `FSUSBLOG_SITE_CONFIG_EDITOR=false` 静默关闭）。

- **基线与版本覆写**：环境变量作为修订 `0` 的只读基线；管理员在 `/admin/site` 保存后，以乐观并发控制（`ExpectedRevision` + `ExpectedDigest`，冲突返回 409）写入 `public.site_config_override` 与 `public.site_config_audit`；规范公开源 `FSUSBLOG_PUBLIC_ORIGIN` 始终由部署环境锁定，不可在线修改。
- **验证边界**：`GET /api/v2/admin/identity/site-config.aeds` 读取当前生效配置；保存通过 `/api/v2/admin/identity/site-config/{step-up/begin,step-up/complete,pow,save}.aeds` 完成一次性 Passkey Step-Up 与 Scoped PoW 校验，执行与启动期完全一致的字段与 URL 校验规则。
- **即时生效与回退**：提交成功后立即原子切换内存预编码 AEDS 帧、`/manifest.webmanifest`、公开 HTML 壳与 `PublicSnapshot`（首页、归档、文章、站点页与 RSS/Atom/JSON Feed），并在服务重启后自动恢复已提交修订。显式设置 `FSUSBLOG_SITE_CONFIG_EDITOR=false` 重启后关闭编辑路由并恢复使用环境变量基线（数据库记录与审计保留）。使用 FsusUI 的既有明暗模式选择。
