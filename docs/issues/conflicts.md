# P0 范围和契约裁决

各方案都保留在台账。下列保守边界用于限定当前切片的主张；它们不是上游需求关闭、对外兼容裁决或完整验收。

| ID | 已确认冲突或边界 | 可选处理和影响 | 未决时的实施范围 |
| --- | --- | --- | --- |
| C1 | [#1764–1766](review-1541-1799.tsv) 希望去除旧 AEDS reader；固定 v1 规格保留 article list 56/76 字节、detail v3/v4 及 search 的旧读取支持。 | 对外仍有受支持消费者时固定兼容读取并单独验证，或通过明确的契约切换弃用。解析版本决定兼容测试和运行面。 | 先证明当前版向量和真实消费者；不给兼容一栏打勾，不以内部 reader 移除推定可破坏 wire。 |
| C2 | [#1917](https://github.com/Ozwasyd/FsusBlog/issues/1917) 的插件声明 codec 与 [#1860](https://github.com/Ozwasyd/FsusBlog/issues/1860)/[#2322](https://github.com/Ozwasyd/FsusBlog/issues/2322) 恰好八种内建类型。 | 仅允许对内建类型声明适配与校验，或给扩展类型建立独立版本化边界。后者影响 schema、迁移、投影和跨栈客户端。 | 第一阶段只允许协议中的内建类型；不得把第三方新类型当已支持。 |
| C3 | [#1761–1762](review-1541-1799.tsv)、[#2218](https://github.com/Ozwasyd/FsusBlog/issues/2218)、[#2221–2223](review-2221-2450.tsv) 要求真实 PostgreSQL/MySQL/SQLite 迁移与字段保全，#2218 另要求三者的服务旧结构拒绝场景；计划运行默认 PostgreSQL，尚未确认其余 provider 是否承担 v2 服务准入或仅作旧数据输入。 | 明确每 provider 的源/目标职责、版本、兼容数据、凭证和恢复测试；数据库类型可在离线阶段多于运行时，但三 provider 旧结构 serve 矩阵范围要单独决策。 | 以真实离线工具验证单一 provider 的结果可单列通过；不声明 v1 数据全量可迁移，不启用运行时兼容层。 |
| C4 | [#3468](https://github.com/Ozwasyd/FsusBlog/issues/3468) 和 [MEM 子项](memory-review.tsv) 要求 Auto memory governor、OS、NUMA、GPU/ReBAR/peer 与 disk spill；当前负载目标和本机测试不覆盖。 | 若采用，单独冻结能力支持、条件激活、预算、供应硬件与多平台证据；若将部分票定为 v1 实现策略，要逐项记录行为替代和压测结论。 | 目前只能证明确实执行的缓存、资源限制和负载；不得用 Unsupported 模拟先进硬件。 |
| C5 | [#2468](https://github.com/Ozwasyd/FsusBlog/issues/2468) 与 [#2474](https://github.com/Ozwasyd/FsusBlog/issues/2474) 均要求未提供深度时默认 1；前者将未知值解析为 1，后者让未知值、0 或大于 2 拒绝。 | 明确 wire 的未知值拒绝和旧界面的正常缺省可否分层执行；如保留宽容解析，需要单独测试并显示有效深度。 | 默认 1、显式 2、异常值应拒绝作为保守切片；兼容性待定。 |
| C6 | [#2487](https://github.com/Ozwasyd/FsusBlog/issues/2487) 的转换计划限于 explicit-reference-note，visual-only 默认不可转换；[#2490](https://github.com/Ozwasyd/FsusBlog/issues/2490) 允许显式选择 visual-only 转换。#2490 提及有序恢复或原子路径，[#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738) 要求真实数据库事务。 | 根据边类型确定可转换产品意图；保持服务端将正文与边状态绑定同一事务，不允许分步写后补偿冒充原子。 | 只实现经授权的确认转换及原子回滚；visual-only 行为仍待裁决。 |
| C7 已裁决 | [#1925](https://github.com/Ozwasyd/FsusBlog/issues/1925)、[#1984](https://github.com/Ozwasyd/FsusBlog/issues/1984)、[#1985](https://github.com/Ozwasyd/FsusBlog/issues/1985)、[#1987](https://github.com/Ozwasyd/FsusBlog/issues/1987) 的自动 npm 发布/消费，与用户要求直接锁定检出的 FsusUI 源码测试合约不符。 | 已按用户范围裁决为旧发布系统限定；继承消费者身份对齐、可重建锁定和真实渲染的教训。 | 不依赖 FsusUI 发行渠道或 v1 自动合并。 |
| C8 已裁决 | [#4759](https://github.com/Ozwasyd/FsusBlog/issues/4759) 中的历史 .NET 11 freshness 建议与 v2 的 .NET 10 LTS servicing 策略不符。 | 使用当前锁定且可复验的 10.0 servicing 工具链；安全修复和漏洞处置仍独立适用。 | 不自动升主版本。 |
