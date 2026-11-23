# 私有资产库与分片续传

> **角色**：功能契约
> **适用对象**：站点部署者、创作者与后端维护者
> **权威依据**：目录发现与开关解析见 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs)；端点实现见 `src/Server/Content/MediaEndpoints.cs` 与 `MediaUploadEndpoints.cs`。

## 1. 启用前提与目录边界

- 配置 `FSUSBLOG_DATA_DIR` 时，服务自动创建 `0700` 权限的 `private-media/` 目录并启用私有资产库与分片续传（`FSUSBLOG_PRIVATE_MEDIA_RESUMABLE` **默认开启**，可显式设为 `false` 仅保留整图上传）；也可通过绝对路径 `FSUSBLOG_PRIVATE_MEDIA_ROOT` 单独覆盖（须无符号链接、与 Web 静态/公开媒体/外观目录互斥，且由当前服务进程独占持有）。显式设 `FSUSBLOG_PRIVATE_MEDIA_ROOT=""` 关闭私有资产库。
- 资产与分片暂存表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。如需扩展支持静态 WebP（默认约束支持 PNG 与 JPEG），停服后执行：
  ```bash
  dotnet FsusBlog.V2.Cli.dll media-webp schema
  dotnet FsusBlog.V2.Cli.dll verify
  ```
  完成后资产列表通过 `X-Fsus-Private-Media-WebP: 1` 公告能力，仅接受静态无动画 WebP（RIFF ≤ 128 chunks，经 Skia 完整解码并重编码为静态无损 WebP）。

## 2. 图片校验与直接上传端点

资产库入口 `/user/manage/assets` 仅限当前有效管理员/作者会话访问，严格按所有者隔离；原图与规范化结果上限均为 **20 MiB**、最大边长 **8192 px**、最大 **16 Mi 像素**，仅接受单帧无需方向校正的 PNG / JPEG（及已升级时的静态 WebP），经 Skia 完整解码重编码去除输入元数据与隐藏载荷。单实例并发限制为上传 2 路、读取 4 路。

| 入口 | 契约 |
| --- | --- |
| `GET /api/v2/media/list.aeds` | 仅返回当前作者可用资产，每页 50 项，按创建时间与 UUID 向前翻页 |
| `POST /api/v2/media/upload.aeds?name=…` | 接收完整图片字节，要求 `Content-Length` 与 UUID `X-Fsus-Client-Mutation-Id`，返回资产 AEDS 坐标 |
| `GET` / `HEAD /api/v2/media/raw/{id}` | 同会话所有者复核，校验文件长度与 SHA-256；缺失/失败/无权统一返回空 `404`（`private, no-store`） |
| `POST /api/v2/media/{id}/remove.aeds` | 先持久标记 `removing` 撤销访问，再核对 SHA-256 后删除物理文件（同键重试可续清，摘要失配保留原文件供核查） |

上传遵循 `pending` → 排他原子落盘 → `ready` 三阶段，确保可见性与持久元数据同源；只要仍有任何已保存历史修订引用该图片，资产库即拒绝永久删除。

## 3. 私有分片续传

| 入口 | 契约 |
| --- | --- |
| `POST /api/v2/media/resumable/begin.aeds` | 无请求体，查询参数 `name`、`type`、`length`（可选 `partSize`，默认 512 KiB，范围 64 KiB–2 MiB），要求命令 UUID 与 `X-Fsus-Private-Media-SHA256` |
| `GET /api/v2/media/resumable/{id}/status.aeds` | 返回所有者的上传 ID、总长度、分片大小、到期时间与已确认分片序号；完成后返回资产 UUID |
| `POST /api/v2/media/resumable/{id}/parts/{part}.aeds` | 从 0 编号，校验精确 `offset`、`Content-Length` 与分片 SHA-256，支持乱序与精确重放 |
| `POST /api/v2/media/resumable/{id}/finalize.aeds` | 校验完整分片、原图 SHA-256 与图片解码后原子落盘并清空暂存分片 |
| `POST /api/v2/media/resumable/{id}/cancel.aeds` | 清理未完成上传会话 |

- 限额：单账号最多 4 个暂存会话、全库最多 16 个、记录总量最多 1,024 条；未预约最终文件的暂存会话 6 小时后过期并分批清理。每次分片写操作均校验 `X-Fsus-Current-Session`。

## 4. 草稿私有附件与短时预览票据

- 作者可在已保存草稿的 Inspector 中关联最多 **32 张**私有图片，增删附件生成新的草稿修订并同事务提交。
- 预览仅限当前作者会话与最新草稿修订：服务端签发 90 秒内存票据（绑定会话、文章、修订与资产），浏览器经固定路径 `GET /api/v2/media/draft-preview` 搭配 `Authorization: Bearer …` 读取（不将票据放入 URL，且 Nginx/Caddy 模板跳过该路径访问日志），匿名/跨作者/旧修订统一返回空 `404`。草稿私有附件不会在普通公开发布时自动暴露（显式公开见 [公开文章图片发布](public-article-media.md)）。

## 5. 验证入口

```bash
FSUSBLOG_TEST_FLOW=private-media bash tests/EndToEnd/run-native.sh
FSUSBLOG_TEST_FLOW=article-media FSUSBLOG_TEST_RESUMABLE_MEDIA=1 bash tests/EndToEnd/run-native.sh
```
