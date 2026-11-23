# 私有文章修订历史与草稿回滚

> **角色**：功能契约
> **适用对象**：创作者与后端维护者
> **权威依据**：端点与事务以 `src/Server/Authoring/` 源码及 `src/Cli/Schema/02-authoring.sql` 为准。

## 1. 修订列表、比较与实时对照

所需修订历史与草稿封面表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。作者在文章编辑器 Inspector 中可查看按修订倒序排列的历史列表（标出当前草稿、当前公开版与历史恢复来源），并支持：

- **双栏修订比较**：宽屏并排、窄屏上下展示两个已保存修订的标题、原始 Markdown 与 UTF-16 长度差，可展开 **Saved summary and classification** 对比保存时的摘要、分类、标签（按 ID 比较）与草稿封面坐标。
- **与当前编辑器对照（Compare with current editor）**：核验已保存坐标后，右栏可直接呈现浏览器当前未保存的标题、正文、摘要与分类草稿以便比对；导出仍严格读取服务端已保存修订。
- **独立历史导出**：可在比较视图直接下载所选历史修订的 Markdown / Word / HTML / EPUB / PDF（见 [保存修订的 Markdown 导入与多格式导出](markdown-export.md)）。

## 2. 接口与回滚事务契约

| 入口 | AEDS 帧与行为 |
| --- | --- |
| `GET /api/v2/authoring/draft/{id}/revisions.aeds?revision=…` | 返回 `32800`，每页最多 20 项；游标绑定当前会话、文章与基准修订，基准变化返回 `409` |
| `GET /api/v2/authoring/draft/{id}/revisions/{sourceRevision}.aeds?revision=…` | 返回 `32801`（附 `map=metadata` 返回 `33068` 摘要与分类标签元数据），同事务核验所有权、基准与来源修订 |
| `POST /api/v2/authoring/rollback.aeds` | 接收 `32802`，填写 8–500 Unicode 字符恢复原因后，在同一事务内执行幂等锁、现行草稿 CAS、复制所选历史修订的正文/分类/标签/封面与私有附件引用，并追加 `draft-rollback` outbox |

- 恢复历史修订生成的是**新的私有草稿修订**，不影响当前已公开文章版本（需显式执行发布才会更新公开版本；管理员跨作者回滚公开版见 [管理员文章回滚](admin-article-rollback.md)）。
- 重复提交相同幂等键与参数返回原回执；同键异参或基准修订过期返回 `409`。

## 3. 草稿封面继承规则

作者可在私有附件面板为当前修订设置或清除草稿封面（绑定当前会话、文章、修订与幂等键）：普通保存自动继承封面，移除对应附件时仅清除新修订封面，回滚历史修订时同步恢复该历史修订的封面与附件引用。相关链接：[文章定时发布](article-schedule.md)、[发布权利快照](publication-rights.md)。
