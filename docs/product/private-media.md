# 私有资产库

固定 v1 提交 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 将可续传上传放在 `/api/binary/upload`，要求独立管理员身份的 `article.write` 权限和 PoW，并使用上传会话和令牌。总长度上限为 20 MiB，分片默认 512 KiB、最大 2 MiB，v1 接收 JPEG、PNG、GIF、WebP 和 ICO。票据入口 `/assets/private/{ticket}` 处理 GET 和 HEAD，无效、无权与缺失使用同一空 404。文章当前版本、草稿和不可变修订的资产引用由数据库账本管理，脱离引用的文件经延迟清理。

当前切片提供独立的 v2 作者私有图片库。部署者在本机创建专用目录，设置权限为 `0700`，用无符号链接的规范绝对路径配置 `FSUSBLOG_PRIVATE_MEDIA_ROOT`。该路径须与前端公开目录分开并由当前进程独占。未配置时不注册媒体 API，资产库显示未启用。当前启用目标为 macOS/Linux。服务启动检查空间配置、数据库现行结构及本地目录锁。对运行用户保留部署目录及文件访问权限，把容量预算放在独立受限卷上。平台和进程自身访问控制是目录保护边界。

`/user/manage/assets` 保留 v1 资产库入口。当前会话必须持有现行作者权限，资产只能由自己的会话查看、预览或删除。上传直接提交 PNG 或 JPEG 图片，要求匹配的文件名后缀与 MIME 类型，并限制原图和结果各 20 MiB、最大边长 8192、最多 16 Mi 像素。内置的 Skia 原生解码器验证完整像素并重新编码，初始版本只接收不需方向校正的单帧图片。原文件的尾部、元数据和压缩结构不会保留。上传最多 2 个并发、读取最多 4 个并发，服务验证会话后才读取请求体，并在两次持久化提交时重新验证当前作者与服务租约。

| 入口 | 契约 |
| --- | --- |
| `GET /api/v2/media/list.aeds` | 仅当前作者的可用资产，每页 50 项，按创建时间和 UUID 向前翻页。 |
| `POST /api/v2/media/upload.aeds?name=…` | 接受完整图片字节，要求 `Content-Length` 和 UUID 格式的 `X-Fsus-Client-Mutation-Id`。返回 AEDS 资产坐标。 |
| `GET` / `HEAD /api/v2/media/raw/{id}` | 同会话作者再授权，验证文件长度和 SHA-256。缺失、失败、无权等状态统一空 404，`private,no-store`。 |
| `POST /api/v2/media/{id}/remove.aeds` | 先持久撤销访问，再核对已知文件才清理。相同删除重试可继续未完成清理。 |

上传首先持久保存 `pending`，随后验证同一作者权限并写入仅服务可见的文件，以原子且不可覆盖的操作建立最终叶名，最后提交 `ready`。可见性与持久元数据同源。提交结果不明时保留已落地的文件及原始身份，允许同键重试，禁止在线回收可能已授权的资源。删除先锁定资产并提交 `removing`，使所有后续请求不可读，然后校验文件 SHA-256 并删除。碰到不匹配的文件会保留原址供控制方处理。临时文件仅在本次独占创建成功后才清理。进程崩溃后不可读的残留应由部署者按资产和操作记录核对，暂未启用自动清理器。备份需要同步 PostgreSQL 和有权限保护的规范根目录，恢复后应逐项核对资产摘要和阶段。

## 私有分片续传

配置私有媒体目录并设置 `FSUSBLOG_PRIVATE_MEDIA_RESUMABLE=true`，可启用 v2 分片 API。现有 FsusUI 资产库继续使用完整图片上传。现有数据库须在停服后执行迁移工具 `private-media-upload schema`，再用 `verify` 检查结构。

| 入口 | 契约 |
| --- | --- |
| `POST /api/v2/media/resumable/begin.aeds` | 无请求体，查询参数为 `name`、`type`、`length`，可选 `partSize`。要求命令 UUID 和 `X-Fsus-Private-Media-SHA256`。相同键和同一清单可续传。 |
| `GET /api/v2/media/resumable/{id}/status.aeds` | 返回所有者的上传 ID、字节数、分片大小、到期时间和已接收分片序号。完成后返回私有资产 UUID。 |
| `POST /api/v2/media/resumable/{id}/parts/{part}.aeds` | 从 0 编号，要求准确的 `offset` 和 `Content-Length`，以 `application/octet-stream` 发送原始分片，并提供该分片 SHA-256。支持乱序和精确重复，不接受同一坐标的其他内容。 |
| `POST /api/v2/media/resumable/{id}/finalize.aeds` | 无请求体，校验完整分片、原图 SHA-256 和图片格式。成功后返回现行私有资产 AEDS 坐标。 |
| `POST /api/v2/media/resumable/{id}/cancel.aeds` | 无请求体，清理未完成上传；已完成资产使用现有删除接口。 |

分片默认 512 KiB，允许 64 KiB 至 2 MiB，完整上传最多 20 MiB。账号最多 4 个暂存会话，实例数据库最多 16 个，完成凭据和暂存会话共最多 1024 条。未预约最终文件的会话 6 小时后失效，在后续创建请求中分批清理。原始分片存在 PostgreSQL 私有暂存表，从未进入公开资源目录。最终文件预约后若进程中断，可使用原上传 ID 继续完成或明确取消；此阶段保留暂存及文件身份，避免自动删除提交状态未知的文件。编码与落盘与直接上传一致，返回现有所有者私有地址，并事务清空分片。

v1 上传票据、PoW、GIF/WebP/ICO、公开坐标与不可变分发、文章引用账本、编辑器内上传、自动孤立清理、旧资产迁移及跨实例票据消费仍待实现。仍需验证生产反向代理和卷容量配置。

2026-11-14 22:47 完成 .NET SDK 10.0.404 锁定恢复、严格 Vue 类型检查和生产构建。两项 PostgreSQL 18.7 集成测试通过，使用实际 Kestrel、SkiaSharp 3.119.4 原生解码及 macOS arm64 私有文件目录。验证正常 PNG、JPEG、错误格式、截断输入、作者隔离、幂等、GET/HEAD 私有读取、待处理恢复以及文件摘要变更时拒绝删除。

Chrome 实际使用本地 FsusUI `f2d929a5d045439c35e93b4771f912ce50ec2337`，在 1280×800 日间主题和 375×850 夜间主题运行上传、键盘预览、取消与确认删除，并确认 PostgreSQL、真实文件和无会话访问结果。测试入口为 `FSUSBLOG_TEST_FLOW=private-media` 与 `tests/EndToEnd/run-native.sh`，工作树、工具链、锁文件、构建摘要、日志、截图和清理结果位于 `artifacts/native-e2e-fsusv2-e2e.NMN9vJ/`。两种视口遍历结束后临时数据库、媒体文件目录和进程均已清理。界面依据固定 v1 资产库源码，归类为有界消费者组合，资产引用清理仍留待引用账本接入。

参考：[v1 文件服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/FileService.cs)、[v1 上传端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs)、[v1 私有资产入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/PrivateAssetEndpoints.cs)、[文章引用账本](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/article-asset-reference-lifecycle.md)。
