# 评论复核增加的验收场景

本表把已读评论中的历史反例和补充规范映射到 v2。对旧候选的复现记录保留来源与范围，v2 运行结果需另行采集。精确条款、处置和来源时间见各 `comments-*.tsv`。总体事项和新的冲突见 [冲突与裁决](conflicts.md)。

| 范围 | v2 应验证的行为 |
| --- | --- |
| 十语言 | 把已经批准的 #1584 术语表及 schema 词条检查纳入十语言首响应和跨表面验收。候选有 12 个目录 archetypes，其中 8 个是 critical。来源 [#1583](https://github.com/Ozwasyd/FsusBlog/issues/1583#issuecomment-5070643484)、[#2097](https://github.com/Ozwasyd/FsusBlog/issues/2097)。 |
| 发布时钟 | 固定业务时钟在预约时刻之前，真实数据库上的公开 revision 仍指向旧发布。只有实际到期时才推进发布、AEDS 和搜索坐标。来源 [#2174](https://github.com/Ozwasyd/FsusBlog/issues/2174)。 |
| 最近历史 | 因归档、删除或撤权不能投影某条记录时，在比较 CAS、返回游标或写缓存前确认空、不可用投影不会借集合版本或摘要泄漏该记录。恢复权限后保留持久的原事实。来源 [#2230 真实旧反例和修复](https://github.com/Ozwasyd/FsusBlog/issues/2230#issuecomment-6246887711)。 |
| 已挂载文章的撤权 | 两个标签都存在时撤权非活动文章，从最近历史打开它必须拒绝，前一个正常标签仍活跃。重置或切换站点后到达的旧 readiness 与旧导航不得恢复已撤销页面。来源 [#2304 竞态](https://github.com/Ozwasyd/FsusBlog/issues/2304#issuecomment-6053355723)。 |
| 公开预览责任和位置 | 正文完全相同的文章 A、B 之间重用缓存时，SSR 校验 draft responsibility 的目的文章和当前文档、revision 才能显示作者和更新者。真实 FsusUI 返回的 opaque node ID 必须使用公开位置映射。来源 [#2283 预览反例](https://github.com/Ozwasyd/FsusBlog/issues/2283#issuecomment-6053334791)、[#2246 位置映射](https://github.com/Ozwasyd/FsusBlog/issues/2246#issuecomment-6053360584)。 |
| 评论发送范围 | 持久化的 `publicSendConfirmed` 恢复为明确待确认状态。同一挂载的编辑器发生文章、主贴、回复 A 或回复 B 切换时，移除上一作用域的 public retry ID。来源 [#1889 真实旧反例](https://github.com/Ozwasyd/FsusBlog/issues/1889#issuecomment-6053476844)。 |
| 批量写入和恢复 | 结果未知的 Prepare 或写入保持待恢复，事务权威证明零写入后才作终态判断。已证实未开始的精确子集可以重试，可能已提交的项只允许恢复。终态后聚合缺失时从原事务收据继续，无业务重放。来源 [#2385 未开始项](https://github.com/Ozwasyd/FsusBlog/issues/2385#issuecomment-6053471871)、[#2395 写入反例](https://github.com/Ozwasyd/FsusBlog/issues/2395#issuecomment-6053444131)、[#2395 聚合反例](https://github.com/Ozwasyd/FsusBlog/issues/2395#issuecomment-6053496122)。 |
| 文章属性和模板 | 只读计划可验证 primitive 或空引用。非空引用需要真实源身份和目标状态，摘要保持 Missing、Null、false、0、空字符串及默认值来源。没有实际接收者时，模板创建在首写前拒绝而不能静默丢弃属性默认值、权利、责任或发布条件。来源 [#2323 只读边界](https://github.com/Ozwasyd/FsusBlog/issues/2323#issuecomment-6052065293)、[#2398 portable mapping](https://github.com/Ozwasyd/FsusBlog/issues/2398#issuecomment-6051585551)、[#2350 创建反例](https://github.com/Ozwasyd/FsusBlog/issues/2350#issuecomment-6052520750)。 |
| 后台文档导出 | 管理员与公开帐号独立。后台 worker 以持久的主体、会话、站点与冻结坐标复验启动、提交、下载，站点映射缺失时拒绝。不可通过 URL 或日志泄露单次下载授权。HEAD 不消费，Range 拒绝，注销或切换站点撤销当前会话授予。重试保持输入、原失败和实际清理归属。公开响应不投影源路径，独立核验输出及沙箱运行身份。来源 [#2434 身份分析](https://github.com/Ozwasyd/FsusBlog/issues/2434#issuecomment-6053518268)、[#2436 下载合同](https://github.com/Ozwasyd/FsusBlog/issues/2436#issuecomment-6053392076)、[#2436 真实服务边界](https://github.com/Ozwasyd/FsusBlog/issues/2436#issuecomment-6054391267)。 |
| 真机安全区 | iOS 17+ 使用有 cutout 和 Home Indicator 的真机 Safari。覆盖横竖屏、地址栏展开收起、焦点、滚动锁以及真实组件，绑定同候选自动 Chromium/WebKit 证据。旧任务曾允许模拟器计入，后续合同重申设备要求。来源 [#2229 当前合同](https://github.com/Ozwasyd/FsusBlog/issues/2229#issuecomment-6051549840)。 |
| 发行和浏览器信任 | Worker 只接受固定发行信任身份及实际已封存且签名的活动清单，清单和 browser artifact 属于同 release。禁止配置在运行时替换信任 key。未知活动身份时拒绝 GC，保护实际共享构件和回滚引用。来源 [#2225 Worker 身份](https://github.com/Ozwasyd/FsusBlog/issues/2225#issuecomment-6053148893)、[#2226 GC](https://github.com/Ozwasyd/FsusBlog/issues/2226#issuecomment-6052912798)、[#3657](https://github.com/Ozwasyd/FsusBlog/issues/3657)。 |
