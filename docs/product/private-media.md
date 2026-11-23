# 私有资产库

固定 v1 提交 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 将可续传上传放在 `/api/binary/upload`，要求独立管理员身份的 `article.write` 权限和 PoW，并使用上传会话和令牌。总长度上限为 20 MiB，分片默认 512 KiB、最大 2 MiB，接收 JPEG、PNG、GIF、WebP 和 ICO，以原始字节登记为公开资产。私有入口 `/assets/private/{ticket}` 用票据读取，无效、无权与缺失使用同一空 404。私有存储策略列出 JPEG、PNG、GIF 和 WebP 的原图用途。文章当前版本、草稿和不可变修订的资产引用由数据库账本管理，脱离引用的文件经延迟清理。

当前切片提供独立的 v2 作者私有图片库。部署者在本机创建专用目录，设置权限为 `0700`，用无符号链接的规范绝对路径配置 `FSUSBLOG_PRIVATE_MEDIA_ROOT`。该路径须与前端公开目录分开并由当前进程独占。未配置时不注册媒体 API，资产库显示未启用。当前启用目标为 macOS/Linux。服务启动检查空间配置、数据库现行结构及本地目录锁。对运行用户保留部署目录及文件访问权限，把容量预算放在独立受限卷上。平台和进程自身访问控制是目录保护边界。

`/user/manage/assets` 保留 v1 资产库入口。当前会话必须持有现行作者权限，资产只能由自己的会话查看、预览或删除。上传接受 PNG、JPEG 和数据库已升级时的静态 WebP，要求匹配的文件名后缀与 MIME 类型。原图和结果各限 20 MiB，最大边长 8192，最多 16 Mi 像素。内置的 Skia 原生解码器验证完整像素并重新编码，只接收不需方向校正的单帧图片。已存文件不保留输入中的元数据或压缩结构。上传最多 2 个并发、读取最多 4 个并发，服务验证会话后才读取请求体，并在两次持久化提交时重新验证当前作者与服务租约。

## 启用静态 WebP

停服后执行迁移工具 `media-webp schema`，再用 `verify` 检查。尚未创建分片暂存表的数据库先执行 `private-media-upload schema`。迁移在同一事务扩展私有资产、分片暂存及已安装的公开文章图片约束，保留原 PNG/JPEG 坐标，可安全重复执行。早期约束继续支持 PNG 与 JPEG。完成升级后，资产列表通过 `X-Fsus-Private-Media-WebP: 1` 公告能力，浏览器才开放 `.webp` 选择。请同步更新前后端再启用。

直接和分片上传均要求 `.webp` 与 `image/webp` 匹配，核对完整 RIFF 长度和数据块边界，最多接受 128 个数据块。带动画标记的 WebP 即使只有一帧也会被拒绝。服务通过原生 Skia 完整解码并重新编码为静态无损 WebP，以实际响应字节计算 SHA-256。私有图片仍由当前作者读取。已启用公开文章图片时，作者可用现有发布流程明确选定衍生图片，撤回沿用现有公开坐标校验。 [WebP RIFF 规范](https://developers.google.com/speed/webp/docs/riff_container)

| 入口 | 契约 |
| --- | --- |
| `GET /api/v2/media/list.aeds` | 仅当前作者的可用资产，每页 50 项，按创建时间和 UUID 向前翻页。 |
| `POST /api/v2/media/upload.aeds?name=…` | 接受完整图片字节，要求 `Content-Length` 和 UUID 格式的 `X-Fsus-Client-Mutation-Id`。返回 AEDS 资产坐标。 |
| `GET` / `HEAD /api/v2/media/raw/{id}` | 同会话作者再授权，验证文件长度和 SHA-256。缺失、失败、无权等状态统一空 404，`private,no-store`。 |
| `POST /api/v2/media/{id}/remove.aeds` | 先持久撤销访问，再核对已知文件才清理。相同删除重试可继续未完成清理。 |

上传首先持久保存 `pending`，随后验证同一作者权限并写入仅服务可见的文件，以原子且不可覆盖的操作建立最终叶名，最后提交 `ready`。可见性与持久元数据同源。提交结果不明时保留已落地的文件及原始身份，允许同键重试，禁止在线回收可能已授权的资源。删除先锁定资产并提交 `removing`，使所有后续请求不可读，然后校验文件 SHA-256 并删除。碰到不匹配的文件会保留原址供控制方处理。临时文件仅在本次独占创建成功后才清理。进程崩溃后不可读的残留应由部署者按资产和操作记录核对，暂未启用自动清理器。备份需要同步 PostgreSQL 和有权限保护的规范根目录，恢复后应逐项核对资产摘要和阶段。

## 私有分片续传

配置私有媒体目录并设置 `FSUSBLOG_PRIVATE_MEDIA_RESUMABLE=true`，可启用 v2 分片 API 和 FsusUI 资产库的续传。站点未启用该配置时，资产库继续使用完整图片上传。现有数据库须在停服后执行迁移工具 `private-media-upload schema`，再用 `verify` 检查结构。

| 入口 | 契约 |
| --- | --- |
| `POST /api/v2/media/resumable/begin.aeds` | 无请求体，查询参数为 `name`、`type`、`length`，可选 `partSize`。要求命令 UUID 和 `X-Fsus-Private-Media-SHA256`。相同键和同一清单可续传。 |
| `GET /api/v2/media/resumable/{id}/status.aeds` | 返回所有者的上传 ID、字节数、分片大小、到期时间和已接收分片序号。完成后返回私有资产 UUID。 |
| `POST /api/v2/media/resumable/{id}/parts/{part}.aeds` | 从 0 编号，要求准确的 `offset` 和 `Content-Length`，以 `application/octet-stream` 发送原始分片，并提供该分片 SHA-256。支持乱序和精确重复，不接受同一坐标的其他内容。 |
| `POST /api/v2/media/resumable/{id}/finalize.aeds` | 无请求体，校验完整分片、原图 SHA-256 和图片格式。成功后返回现行私有资产 AEDS 坐标。 |
| `POST /api/v2/media/resumable/{id}/cancel.aeds` | 无请求体，清理未完成上传；已完成资产使用现有删除接口。 |

分片默认 512 KiB，允许 64 KiB 至 2 MiB，完整上传最多 20 MiB。账号最多 4 个暂存会话，实例数据库最多 16 个，完成凭据和暂存会话共最多 1024 条。未预约最终文件的会话 6 小时后失效，在后续创建请求中分批清理。原始分片存在 PostgreSQL 私有暂存表，从未进入公开资源目录。最终文件预约后若进程中断，可使用原上传 ID 继续完成或明确取消；此阶段保留暂存及文件身份，避免自动删除提交状态未知的文件。编码与落盘与直接上传一致，返回现有所有者私有地址，并事务清空分片。

浏览器在当前标签页、当前登录会话内保留随机命令键。读取本地文件计算 SHA-256 并与文件名、格式和大小共同确定此次上传。页面重新载入后，可重新选择相同文件继续，仅补传服务端尚未确认的分片。浏览器不写入本地图像副本或文件名。每次分片写操作都要求 `X-Fsus-Current-Session` 与真实会话匹配，切换账号或会话后从新上传开始，原会话仍可在有效期内继续或取消。

2026-11-15 本机 Chrome 在 1280×800 和 375×850 验证分片开启及默认关闭。分片开启时，测试让第二片请求网络中断，重载并重新选择同一图像只传缺片。同名同大小的不同字节取得新的命令键，同标签页换真实作者会话也重新上传。真实 PostgreSQL 确认三次完成，取消及完成后无残留分片，三个私有图片均可删除。证据位于 `artifacts/private-media-ui/`。

## 草稿私有附件

启用私有资产库时，作者可在已保存草稿的检查器中关联自己的私有图片，每个修订最多 32 张。添加或移除附件产生新的草稿修订，图片引用与修订、命令键和出站事件在同一 PostgreSQL 事务提交。保存文字或设置保留原引用，回退恢复所选历史修订的引用。原有数据库须停服执行 `article-private-media`，再执行 `verify`。

预览要求作者当前会话且对应草稿的最新修订。90 秒票据绑定会话、文章、修订和资产，读取时重新检查该作者的当前权限、引用和实际文件摘要。浏览器请求固定路径 `/api/v2/media/draft-preview`，通过 `Authorization: Bearer …` 发送票据，显示内存对象 URL，在关闭预览、切换会话或修订后释放。要部署这次预览变更，请一起升级服务和前端。匿名、其他作者、缺少票据、过期或修改票据及旧修订均返回同一空 404。票据无需持久化，服务重启后须重新取得。文章公开发布不导出这类附件，Markdown 内容原样保留。

只要仍有任何已保留修订引用图片，资产库就拒绝永久删除。即使当前草稿已移除该附件，历史修订仍可回退到引用该图的状态。本阶段没有删除历史修订和自动清理，保留期间会继续占用磁盘。

2026-11-15 在实际 PostgreSQL 和 Kestrel 验证所有权、幂等、票据改写及修订失效、历史回退和发布页面无附件地址。桌面和窄屏 Chrome 通过 FsusUI 检查器添加、键盘预览和移除，匿名请求无法读取预览。。

早期浏览器运行的 ASP.NET 请求日志曾记录预览 URL 中的短时票据。该次临时服务和会话均已销毁。改为固定路径后，启用请求日志的 Kestrel 上复测桌面和窄屏，日志可见固定路径，票据和值均未写入。交付的 Caddy 默认关闭站点访问日志，并为新旧预览路径配置 `log_skip`。Caddy 2.11.9 的 TLS 对照测试临时打开访问日志，控制请求有记录，两条预览路径均跳过。

v1 上传票据、PoW、GIF、WebP 动画保留、公开 ICO 上传、Markdown 公开引用解析、编辑器内上传、自动孤立清理、旧资产迁移及跨实例票据消费仍待实现。仍需验证生产反向代理和卷容量配置。

2026-11-14 22:47 完成 .NET SDK 10.0.404 锁定恢复、严格 Vue 类型检查和生产构建。两项 PostgreSQL 18.7 集成测试通过，使用实际 Kestrel、SkiaSharp 3.119.4 原生解码及 macOS arm64 私有文件目录。验证正常 PNG、JPEG、错误格式、截断输入、作者隔离、幂等、GET/HEAD 私有读取、待处理恢复以及文件摘要变更时拒绝删除。

Chrome 实际使用本地 FsusUI `f2d929a5d045439c35e93b4771f912ce50ec2337`，在 1280×800 日间主题和 375×850 夜间主题运行上传、键盘预览、取消与确认删除，并确认 PostgreSQL、真实文件和无会话访问结果。测试入口为 `FSUSBLOG_TEST_FLOW=private-media` 与 `tests/EndToEnd/run-native.sh`，工作树、工具链、锁文件、构建摘要、日志、截图和清理结果位于 `artifacts/native-e2e-fsusv2-e2e.NMN9vJ/`。两种视口遍历结束后临时数据库、媒体文件目录和进程均已清理。界面依据固定 v1 资产库源码，归类为有界消费者组合，资产引用清理仍留待引用账本接入。

参考：[v1 文件服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/FileService.cs)、[v1 上传端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs)、[v1 私有资产入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/PrivateAssetEndpoints.cs)、[文章引用账本](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/article-asset-reference-lifecycle.md)。
