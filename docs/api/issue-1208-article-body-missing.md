# Issue 1208：发布文章正文缺失契约

## 公开读取语义

发布态文章必须同时具备非空的 `article_body.markdown_content`。详情读取发现正文行不存在或正文为空白时：

- 返回统一错误 `InfraFailure / article_body_missing`；
- 不再把 `summary` 投影为 `content`；
- 不写入详情缓存，不生成新的 ArticleDetail AEDS、Public AOT 或 public-hot 正文产物；
- 不把该文章加入新的正文搜索索引快照；
- 记录低基数观测事件，并把文章 ID 放入进程内修复队列。

草稿态文章允许空正文。后台使用 `includePrivate` 读取草稿时，空正文仍按空字符串返回，不转换为 `article_body_missing`。

## 各调用身份覆盖

| 场景 | 结果 |
| --- | --- |
| 匿名读取发布文章 | 正文有效时返回详情；正文缺失时返回 `article_body_missing` |
| 登录用户读取发布文章 | 与匿名读取相同，不因登录状态恢复摘要回填 |
| admin 读取草稿 | 允许空正文，保留草稿语义 |
| notification stream | 不新增事件信封；修复后的现有缓存/投影失效链负责刷新消费者 |
| binary ArticleDetail | 正文缺失时不生成或写入新的 AEDS 详情帧 |

## 客户端处理

客户端收到 `article_body_missing` 时应显示“正文暂不可用，请稍后重试”，不得把摘要渲染到正文区域。该错误表示服务端数据一致性故障，不表示文章不存在。

## 兼容边界

本变更不修改路由、AEDS 帧结构、`AedsFrameType`、POD 尺寸或 notification stream 信封。现有完整正文的文章响应保持不变。
