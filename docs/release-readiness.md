# 发布验收仍需验证的边界

目前的 Git 历史包含可运行的 v2 和多次独立候选。每项证据只适用于对应提交、配置、工具链和输入。最终发布需要从同一冻结提交复验各域并证明完整性。

| 验收项 | 已验证的范围 | 发布前仍需完成 |
| --- | --- | --- |
| 公开发布与读取 | 实库和 Chrome 覆盖保存、CAS、发布、撤回、定时发布、权利快照和 outbox 恢复。已实测管理员回滚到公开版、作者草稿或归档，以及从归档重新发布。租约交接、冷读限制、FSPT 在线补丁及标准订阅源已验证。物理备库升主验证旧实例拒绝、原发布读取与幂等重试。封存包实测旧主回卷为备库，旧进程继续拒绝读写，两库新发布与权利记录一致。原生权利证明、浏览器验签、同事务签发、外部锚定的签名日志头、离线发布及日 Merkle 检查点均有验证。历史日归档、最新签发检查点与当前公开文章的 Merkle 成员证明通过实库、真实 Caddy TLS 和独立验签。独立签名进程自动生成已闭合 UTC 日检查点，隔离库验证了空日、非空日、原件复用和错误锚点拒绝。Debian ARM64 已用专用系统账号、列级只读权限及实际 systemd 定时触发验证签发，两类私钥保持独立。真实 HTTPS 停留统计及可选热门列表已验证，榜单热读零数据库调用。 | 完整非公开来源矩阵、完整历史责任、生产定时器与独立时间见证、原 Wasm 排名等价、生产集群编排、外部隔离与多节点媒体一致性。 |
| 身份与授权 | 双 HTTPS 主机覆盖独立管理员 Passkey、独立审计权限、Cookie 隔离、来源拒绝、当前授权和私有近期成功登录。账号 TOTP、一次性恢复码、Recovery Key 重绑 Passkey、会话撤销、编辑期间的持久续期、跨账号写入拒绝及受限评论 PoW 已有实库与浏览器证据。普通账号自己的凭据清单、以新 WebAuthn 断言重命名凭据、从当前凭据批准添加第二设备及计数器回退拒绝另经验证。管理员只读诊断已覆盖五种实际路由与通知存储配置。实测顶层评论 PoW 策略的 Passkey 更新、回退和旧代失效。站点页面兼容旧 PUT 和 AEDS 帧，沿用管理员来源、Passkey、PoW 和修订条件。 | 公网部署、完整管理员角色、通用动态风险评分及挑战提供方、强匿名及旧凭据切换。 |
| 内容、工作区与沟通 | FsusUI 源码双组已验证持久顺序、跨屏折叠、分隔条键鼠调节与真实页面缩放、活动稿件移动和合并、单标签及批量保存后关闭、显式丢弃及重开恢复未保存稿。已实测作者文章库、键盘快速切换并保留未保存稿件、原子属性批写、固定视图、八种属性的存在筛选、单选及多选的任一匹配、保存视图、标题或摘要与属性合取、私有作者全文的章节与属性混合检索、类型化排序和分面、原文精确定位、显式插入、删除和替换跨保存修订、万篇后台续建及三种宽度的浏览器翻页、授权归档原文预览、私有媒体和明确选择的公开图片及撤回、万节点 Canvas、精确引用锚点及显式和视觉边原子转换。1,000 个字段、10,000 篇文章和 88,000 个属性值在同一实库验证了定义和分页、授权、筛选、排序及分面。Chrome 实测千字段分页最多挂载 25 个控件。保存、即时与定时发布和回滚的属性快照通过实库验证，私有修订比较的数值、历史名称及匿名拒绝有真实浏览器证据。静态 WebP 的续传、私有预览、显式发布及撤回另有实库和 Chrome 证据。工单、站内信、WebSocket 重连、作者删除、登录回复通知、独立申诉复核和待审批量批准与驳回均有原生与实际浏览器结果。管理员首屏新工单、会话及队列的状态同步和已打开工单的实时回复，已通过独立 Caddy TLS、实库和 Chrome 验收，含重连、会话撤销和默认关闭。登录用户编辑及举报重复回执也已通过实库与 Chrome。 | 富编辑器完整跨组状态恢复、附件义务与独立关闭回执、万篇混合检索和独立查询收据、保存视图全量迁移、Canvas 标题和块链接的公开定位及完整无障碍、公开附件网关预算、管理员全事件持久回放和广播、外部订阅提供方及其余评论状态与异常身份。 |
| 迁移与扩展 | 实库验证私有媒体备份及公开派生图片重建、三库方言隔离候选续跑和恢复、PostgreSQL 计划换库与结构漂移拒绝、旧首次发布、再发布和公开回滚的终态 outbox 保全。已在独立可丢弃的副本真实启动首发记录并验证重启。现有导入演练还逐项重算了固定 v1 的三张 PostgreSQL 分类派生表，并用隔离影子表保全旧文章浏览数及种子、八张 v1 保存视图表和操作回执，已独立重算原查询、账号与站点归属及集合摘要。原生 v1 备份恢复后，隔离导入、断点续跑和目标回退已通过。非空私有媒体包也已绑定恢复库、站点、作者及未发布修订，并通过共同候选检查点和独立恢复。旧 PNG 经现行规范化器生成制品并从隔离候选独立复验，macOS 和 Linux ARM64 复算样本输出一致。单件旧私有 PNG 在经独立批准的运行副本完成实际落盘、启用和联合备份恢复，只有所有者能读到规范化文件。macOS 离线插件、签名外观、单字体原始档、选定 `.fstheme` 配色和 Markdown、Word、基础单篇 HTML、EPUB 和单篇 PDF 导出已实测。375px 浏览器已核对 UTF-8 Markdown 导入私有新稿的原始字节、保存及重载。PDF 覆盖 macOS 和 Debian ARM64。异步四格式任务已验证修订冻结、回执、私有下载、排队取消和过期清理。375px 浏览器复验 HTML、PDF。桌面和 375px Chrome 实测单张获授权的历史修订图片内嵌到离线 HTML，文件可无网络打开。四格式支持离线表格，旧任务仍以原提供方版本呈递。运行中 PDF 取消、租约丢失与正常运行时收到 SIGTERM 后的子进程回收均已实测。真实 HTTPS 验证配色切换、回退、撤销及签名字体的管理员许可证和来源详情。Debian ARM64 核验了默认关闭的离线签名插件宿主、沙箱限额、信任变化和调用者异常退出后的回收。同源 HTTPS 的作者签名插件预览已通过原生验证。暂存 broker 保留原签名安装存储的独占授权直至句柄清理。实库验证了持有签名能力的保存稿件范围读取、并行撤销、取消和旧修订拒绝。 | 完整旧库转换、旧属性历史导入、身份媒体权限对账和生产激活、备份密钥与生产交接、通用在线插件 Hook、用户授权和 IO broker，通用旧主题和字体、完整文档版式、资产与元数据清单和导出规模预算。 |
| 性能与稳定性 | 原生直连、Caddy TLS、冷缓存、隔离故障及完全清理均有证据。堆硬上限长测 900 秒、RSS 峰值 842,800 KiB，四条热读零数据库命令。早期两轮本机直连最高档达到数字门槛。一次 11,000 档系统采样诊断两种拓扑均正确完成 660,000 次。C11 同一发布包验证 10 万篇文章及 100 万条评论的 SQL 回读、16 个登记用例的 HTTP 语义及四个评论目标的实际 PostgreSQL 执行计划。固定 xs 的 11 项适用用例和空根页两条 SQL 的服务端参数类型已核对。宽语料浏览器用 26,002 篇验证损坏和撤回，并在满档库核对 85,000 篇的分片、正文和第 8,500 页。 | `f303f5c` 的四轮独占短档仅直连 A 达到数字门槛。两轮 TLS 和直连 B 的漏发超过 0.1%，正式长时验收的前置条件未满足。独立百万篇文章在同一 PostgreSQL 通过写入、归档与修订字节校验。C11 固定 s 的 11 项通过，3 项不适用。两项公开搜索的固定单篇预期与 v1、v2 的词元并集召回冲突并判为未通过。固定 m 同样通过 11 项，3 项不适用，两个公开搜索仍未通过。跨档趋势、逐例性能门槛、其余参数类型、百万档在线查询和跨提供方仍需验证。 [最新容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收) · [供给诊断](../tests/Performance/supplier-2026-11-15.md) · [满档查询证据](issues/risk-scale-query-cases.md) · [宽语料浏览器](product/public-search.md) |
| 发布包 | macOS 上由锁定引用生成运行包和完整 Git bundle，独立导入后核对摘要、Git 和真实媒体运行。Debian 13 ARM64 通过同一框架依赖发布包摘要校验、PostgreSQL 迁移及重启前后公开快照复核。 | 从最终验收提交生成并验证目标平台发布包。外部执行 Docker 验收，单列结果。完整代码量重新计算。 |

未通过的样本保留在 [性能诊断](../tests/Performance/)中。产品和议题边界以[执行状态](status.md)、[风险条款](issues/risk-trace.md)、[发布及身份条款](issues/risk-release-trace.md)和[剩余代码预算](product/code-budget-checkpoint.md)为准。

## 开发提交 `6a53e4d`

- 当前 Passkey 可重新验证并撤销另一台设备的凭据、会话、持久刷新链和待完成 MFA 登录。实际 Chrome 覆盖两台虚拟认证器、重复提交拒绝及 PostgreSQL 故障时的完整回滚。合并后原生测试 14 项通过。 [浏览器](../artifacts/passkey-removal-09e4b27/) · [实库](../artifacts/delivery-integration-09e4b27/passkey-native.log)
- 属性 Inspector 修复了键盘打开编辑和取消时的焦点。真实 Chrome 通过 100%、150%、200% 缩放与浅深主题的六组组合，覆盖八种属性控件、历史比较和真实 409 的可访问性警报。VoiceOver 实际播报待验证。 [浏览器](../artifacts/property-accessibility-09e4b27/chromium-4/property-inspector-scale-result.json)
- 固定 v1 DDL 的定义演练只读核对文本、数值、布尔、日期四种定义，以及源摘要和目标修订。两个所有者、三个旧 PNG、四条私有修订引用的批次通过隔离启用、重跑、备份恢复和权限校验，仍兼容旧的单件审批。完整旧属性值与审计迁移、其余旧媒体及生产切换待完成。 [定义实库](../artifacts/delivery-integration-09e4b27/property-migration-process.log) · [媒体批次](../artifacts/delivery-integration-09e4b27/media-activation.log) · [旧审批兼容](../artifacts/legacy-media-batch-09e4b27/native-single-compat-final-2.log)
- 锁定依赖的 .NET Release 编译、协议生成检查、140 项 Node 协议测试及 C#、C++、Wasm 验证通过。严格 Vue 类型检查、前端构建及三个 FsusUI Wasm 源产物字节对比通过。封存 `f303f5c` 及其正式验收结果继续保留，`6a53e4d` 的证据用于本批开发变更。 [编译和 Wasm 校验](../artifacts/delivery-integration-09e4b27/) · [协议](../artifacts/passkey-removal-09e4b27/main-protocol-all.txt) · [冻结容量](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `4556f8e`

- 恢复密钥加当前 Passkey 的重新验证可移除当前或最后一个凭据。Chrome 经 Caddy TLS 验证了最后凭据撤销、旧会话失效、同一恢复密钥重绑及既有 MFA。原生检查验证预先签发的普通票据拒绝、缺少可选结构的请求拒绝及其他账号的会话。 [合并提交实测](../artifacts/targeted-delivery-82d0180/combined-runtime/)
- 私有属性筛选、全文约束和保存视图复用同字段任一匹配。实库验证不同字段仍取交集、游标绑定完整候选、旧视图编码及跨作者拒绝。375px Chrome 以键盘建立两条候选条件，重新打开保存视图后仍得到同一文章。 [实库和浏览器](../artifacts/property-alternatives-82d0180/) · [查询合同](https://github.com/Ozwasyd/FsusBlog/issues/2341)
- 旧私有媒体在隔离运行副本启用两个 PNG 与一个 JPEG，恢复后 JPEG 的原件和预览均返回同一规范化字节，兼容旧单件 PNG 审批。原生 Chrome 验证了授权修订的一张私有图片可嵌入 EPUB，桌面及 375px 都可无网络打开。旧保存视图的主排序无法沿现有文章 ID 语义启用，继续保留在隔离数据中。 [媒体](../artifacts/legacy-media-jpeg-82d0180/) · [EPUB](../artifacts/targeted-delivery-82d0180/epub/) · [迁移约束](migration-source.md)
- 12 个可选结构安装器共用两段既有事务流程。PostgreSQL 的 43 项新旧 CLI 对照通过，退出码、输出、结构及数据一致。合并提交通过锁定编译、严格 Vue 类型检查、三份 FsusUI Wasm 字节核对、141 项 Node 协议检查及 C#、C++、Wasm 向量。 [CLI 对照](../artifacts/targeted-delivery-82d0180/optional-schema/compare.log) · [合并构建](../artifacts/targeted-delivery-82d0180/)
- 公开 Canvas 标题、段落及代码块定位仍缺 FsusUI 的精确目标映射，匿名 Chrome 复现已提交至既有 issue。正式容量沿用封存包结果，四轮短档 1 次通过，900 秒正式长测未开始。 [FsusUI 复现](https://github.com/Ozwasyd/FsusUI/issues/1082#issuecomment-6898820348) · [容量结果](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `268e8c6`

- 旧 PostgreSQL 即时首发可在独立审批和可回退备份下启用。合并产物从恢复的旧库处理一篇文章，核对错误来源和目标拒绝、篡改权利拒绝、重复执行、启用前回退和启用后恢复。实际 Kestrel 重启前后公开文章、权利及搜索结果一致。全量生产切换仍待执行。 [原生演练](../artifacts/targeted-delivery-967805c/combined-activation.log) · [迁移准入](migration-source.md)
- 现有签名 Markdown 预览在作者审核插件版本、包摘要和保存修订后才运行。一次性授权绑定当前账号、会话、修订和运维批准。Debian ARM64 通过证书固定 HTTPS、真实 PostgreSQL 与签名隔离 worker 验证了重复使用、越权、替换批准和无授权拒绝。同一签名 worker 的 375px Chrome 流程验证了键盘审核、取消零执行请求及确认后呈递保存修订。发布 Hook 和通用 IO broker 待交付。 [Debian 实测](../artifacts/plugin-user-consent-967805c/debian-native.log) · [Chrome 实测](../artifacts/plugin-user-consent-967805c/chromium-3/plugin-consent-chrome.json)
- 背景标签可跨组移动，两组选中会话、路由、编辑器及选区继续保留。36 项注册表测试和桌面、375px 原生 Chrome 通过。 [浏览器](../artifacts/targeted-delivery-967805c/background-tabs/chromium-3/workspace-split-result.json)
- 已保存修订的单张授权 PNG 或 JPEG 可写入 DOCX。原生 Chrome 下载后用禁网 LibreOffice 打开并渲染实际图片。旧版和当前无附图的两种 DOCX 样本与基线字节一致。 [下载](../artifacts/targeted-delivery-967805c/word/browser/article-media-browser.json) · [独立读取](../artifacts/targeted-delivery-967805c/word/independent/independent-image.log)
- 锁定依赖的 Release 编译、严格 Vue 类型检查及三份 FsusUI Wasm 字节对照通过。作者实库共用夹具后仍通过 12 项，包括千字段、万篇和 88,000 个属性值，规范化净减 193 行。整批开发代码共 208,029 行，距 208,546 上限 517 行。 [编译及计量](../artifacts/targeted-delivery-967805c/) · [实库规模回归](../artifacts/targeted-delivery-967805c/author-fixtures/verification.log)

## 开发提交 `7a1558d`

- 旧库普通再发布链经过审批可直接启用到独立 PostgreSQL 运行副本。合并产物从已恢复旧库启用并复验同一审批，修改历史修订后拒绝继续。再次备份恢复后的 Kestrel 返回修订 2、发布 `900000002`、权利 `701`，拒绝旧公开关联和证明坐标。兼容首发模式。旧公开回滚及责任主体映射仍待完成。 [合并复验](../artifacts/delivery-review-72d684d/combined-republish.log) · [三条原生演练](../artifacts/legacy-republish-activation-72d684d/native-suite-status-2.txt)
- 新增独立作者搜索页，列表与搜索执行同一保存视图。Chrome 验证执行请求字节与结果顺序一致，拒绝匿名和已移除视图。快速切换器另经真实查询验收，账号恢复后即使浏览器收到延迟的旧 HTTP 200，也只显示当前结果。 [保存视图](../artifacts/delivery-review-72d684d/saved-view-search/saved-view-search-result.json) · [迟到响应](../artifacts/delivery-review-72d684d/article-library/article-library-result.json)
- 有其他 Passkey 时，可用当前设备的新 WebAuthn 验证移除当前设备。Chromium 实测目标会话、刷新链和待完成 MFA 撤销，另一设备会话保留。普通路径拒绝移除最后一枚。锁定 Release 和严格 Vue 检查通过。 [当前设备](../artifacts/delivery-review-72d684d/passkeys/current/passkey-result.json) · [构建](../artifacts/delivery-review-72d684d/)
- 原生导出 worker 拒绝已入队修订的保存时间变化。恢复输入及重启后，同一任务保留原失败回执，新任务使用同一冻结输入成功导出原历史正文。固定 PDF 工具的运行中取消、SIGTERM 及租约丢失三项也通过。异步附件清单及完整元数据仍待交付。 [实库记录](../artifacts/delivery-review-72d684d/combined-native.log) · [PDF 实测](../artifacts/delivery-review-72d684d/pdf-targeted/verification.log)
- 414 条采用或合并采用的冻结评论均有显式条款 ID，正文自由文本逐项裁断仍待完成。共用目录探针净减 167 行，61 项新旧 CLI 对照和 7 项原生测试通过。合计 208,250 NCLOC，距上限 296 行。 [冻结台账](issues/review-completeness.md) · [CLI 对照](../artifacts/delivery-review-72d684d/catalog/compare.log) · [计量](product/code-budget-checkpoint.md)

## 开发提交 `e3d58b9`

- v4 可在同一审批批次启用即时首发与普通再发布。恢复后的独立 Kestrel 核验两篇文章的当前公开坐标，旧坐标无法作为当前公开版本读取。隔离库保留三条发布事件和 21 条终态投递。篡改历史修订后，同一审批被拒绝。v5 公开回滚的旧责任治理和操作者映射仍待实现。 [合并演练](../artifacts/targeted-delivery-99abb41/combined-migration.log) · [兼容演练](../artifacts/legacy-mixed-release-99abb41/native-suite-status-2.txt)
- Chrome 验证桌面切回原工作组时保留已打开的大纲和键盘导航位置，焦点仍进入编辑器。375px Drawer 的关闭与焦点恢复通过。管理员系统通知页通过真实 Caddy TLS 收到通知并重新读取，缺少共享投影和仅带站点会话的订阅均被拒绝。 [工作区](../artifacts/targeted-delivery-99abb41/workspace-outline/) · [收件箱](../artifacts/targeted-delivery-99abb41/combined-admin-browser/) · [实库](../artifacts/targeted-delivery-99abb41/combined-inbox-media.log)
- 签名插件授权绑定批准文件内容和打开文件的变更标识。Debian ARM64 复现旧代码接受撤下后恢复的授权，修复后 HTTPS、实库及签名 worker 拒绝旧授权并接受新授权。macOS 离线测试验证撤下再恢复也会中止正在运行的结果。 [Debian 实测](../artifacts/plugin-approval-aba-99abb41/debian-native.log) · [macOS 实测](../artifacts/plugin-approval-aba-99abb41/macos-in-flight-restore.log)
- 异步 HTML 界面可从私有预览明确选择单张图片。第 3 版任务在 worker 重启后仍按所选历史修订重建输入，图片篡改会阻止下载。旧第 1、2 版任务升级前后的记录和输出字节一致。桌面和 375px Chrome 通过。遇到存储损坏时，已成功的回执可能仍在，下载会拒绝。完整附件清单、版式及异步 PDF 附图仍待交付。 [浏览器](../artifacts/targeted-delivery-99abb41/combined-export-browser/article-media-browser.json) · [实库与旧版本升级](../artifacts/targeted-delivery-99abb41/export-attachment/)
- 锁定 Release 编译、严格 Vue 类型检查、Vite、三份 FsusUI Wasm 字节比对及 141 项协议测试通过。夹具复用净减 236 NCLOC，受影响的 114 项全部通过。全套集成首轮到达监督时限，结果仅计入已运行的用例。当前代码量为 208,541 NCLOC，距上限 5 行。正式容量沿用封存包四轮短档的结果，1 轮通过，900 秒正式长测未开始。 [合并检查](../artifacts/targeted-delivery-99abb41/) · [夹具覆盖](../artifacts/targeted-delivery-99abb41/fixture-reuse/scope-coverage.json) · [正式容量](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `845f8c1`

- v5 单篇公开回滚已从恢复的 V1 库实际启用。独立 PostgreSQL 备份恢复后，Kestrel 返回当前和历史责任清单，保留原操作者、快照及 21 条投递边。篡改旧记录后原审批被拒绝。清单禁止缓存，文章撤出公开后当前和历史入口都返回 404。兼容回归通过 v3 首发、v4 混合批次及缺少可选架构时拒绝启用。自定义责任人与来源、已签发的旧证明及全量生产切换待完成。 [合并演练](../artifacts/targeted-delivery-6eccdaf/final-v5.log) · [兼容性](../artifacts/legacy-v5-accountability-6eccdaf/native-suite-status-2.txt)
- 旧管理员会话的迟到运维状态响应无法写入当前页面。真实 Caddy TLS 和 Passkey 验证了会话切换及响应在途撤权。375px Chrome 验证快速切换器可用键盘打开另一编辑组，已打开的稿件仍回到原组，未保存状态保留。 [双 HTTPS 会话](../artifacts/targeted-delivery-6eccdaf/new-ops/) · [浏览器工作区](../artifacts/targeted-delivery-6eccdaf/quick-switcher/)
- 离线 HTML 可按顺序内嵌同一保存修订的最多四张授权图片。实库验证越权、重复及损坏时拒绝整份导出，桌面和 375px Chrome 实测双图下载。累计上限为 512 KiB，未独立实跑大图超限样本。异步多图和完整清单仍待交付。 [浏览器](../artifacts/targeted-delivery-6eccdaf/multi-image-chrome/article-media-browser.json) · [定向测试](../artifacts/targeted-delivery-6eccdaf/final-native.log)
- 锁定 Release 编译、140 项 Core、141 项协议、严格 Vue 及本地 FsusUI 三份 Wasm 字节对比通过。定向 PostgreSQL 19 项通过，PDF 和旧来源专用配置两项跳过。七组 schema 命令的 34 项原生对照、两平台私有媒体恢复和 Debian 签名 worker 通过。身份夹具的三组回归及首发、再发布、回滚 outbox 夹具通过。 [合并检查](../artifacts/targeted-delivery-6eccdaf/) · [身份升级](../artifacts/identity-fixture-6eccdaf/)
- 同口径计量共 208,998 NCLOC，超出上限 452 行。完整代码量门槛尚未通过。正式容量沿用封存包结果，四轮短档 1 次通过，900 秒正式长测未开始。 [计量](../artifacts/targeted-delivery-6eccdaf/code-volume.json) · [正式容量](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `88d1f2b`

- v5 公开回滚保全具名作者、审阅人、公开来源和无时区生效时间。真实 PostgreSQL 备份恢复后，Kestrel 核对清单顺序、微秒和原责任快照。私人来源保留在迁移记录中。修改私人来源后原审批拒绝复验，错误类型在启用前被拒绝，运行库仍与基线备份一致。缺省清单与上一版响应逐字节一致。自定义站点配置、更多责任快照版本、已签发的旧证明和正式切换待完成。 [合并演练](../artifacts/targeted-delivery-0ee6af9/combined-v5-authors.log) · [三项原生用例](../artifacts/targeted-delivery-0ee6af9/v5-authors/native-suite-status-2.txt)
- 双栏编辑器可用 FsusUI 的「Equalize group widths」恢复 50/50。实测保留当前稿件、编辑器及选区，两个窗格相差至多 1px。合并后的 Chrome 在六种宽度及 100%、150%、200% 缩放通过。 [双栏回归](../artifacts/targeted-delivery-0ee6af9/combined-workspace/workspace-split-result.json)
- 共用管理员动作、导出实现和原生测试夹具后，完整代码量为 208,449 NCLOC，低于上限 97 行。真实 Caddy TLS 的管理员发布、草稿回滚及归档再发布通过。导出复用有 25 项文件或摘要样本逐字节一致，其中 PDF 字节对比覆盖渲染器输入，实际 PDF 另经 macOS 隔离运行。锁定 Release、141 项协议、Vite 及三份本地 FsusUI Wasm 比对通过。合并版定向实库 24 项通过，专用 PDF 配置跳过 1 项。作者端夹具的六组 Chrome 有完整终态。 [全部合并证据](../artifacts/targeted-delivery-0ee6af9/) · [规范化计量](../artifacts/targeted-delivery-0ee6af9/code-volume.json)

## 开发提交 `8e1cf2b`

- 文章库可将分类、标签、标题和发布状态取交集。浏览器实测清除筛选后回到第一页，活动稿件仍单独显示，同分类同标签的其他作者稿件不会出现。 [合并版浏览器](../artifacts/short-path-f9fc6d7/chrome-article-library/article-library-result.json)
- 异步 HTML 导出按顺序冻结保存修订中的 2 至 4 张授权图片，共用 512 KiB 预算。执行和下载重新核对每张图，损坏则拒绝整份导出。实际 Chrome 覆盖桌面和窄屏，PostgreSQL 的三个旧版本均通过停服升级并保留旧任务记录。25 项旧提供方文件或摘要逐字节一致，PDF 的字节对比覆盖渲染器输入，实际 PDF 输出另经原生测试。完整导出回执及其他格式的多图支持待完成。 [多图浏览器](../artifacts/short-path-f9fc6d7/verified-lanes/document-html-v4-chrome.json) · [旧任务升级](../artifacts/short-path-f9fc6d7/verified-lanes/document-stopped-upgrade.log)
- v5 从隔离恢复的旧库保留 `Seo_Author` 原值并按 v1 的 20 字节规则计算公开署名。另支持验签并保全一条经独立审批的旧发布证明及公钥。恢复后证明原件字节一致，错误签名、已撤销或受损密钥、遗漏审批均被拒绝。附加责任历史、旧证明整库迁移和公开验证仍待完成。 [自定义作者演练](../artifacts/short-path-f9fc6d7/migration-site-author/) · [旧证明演练](../artifacts/short-path-f9fc6d7/migration-proof/)
- 锁定 Release 编译、140 项 Core、141 项协议、严格 Vue 检查和 Vite 构建通过。三个 FsusUI Wasm 与本地源码产物逐字节一致。合并版定向 PostgreSQL 30 项通过，含真实 PDF。正式口径为 208,475 NCLOC，低于上限 71 行。封存候选 `f303f5c` 继续使用原包，四轮短档通过 1 轮，900 秒正式长测待执行。 [合并版证据](../artifacts/short-path-f9fc6d7/) · [规范化计量](../artifacts/short-path-f9fc6d7/code-volume.json) · [正式容量](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `09fc9f8`

- 从 PostgreSQL 归档恢复后，v5 保全原第二修订的两个历史责任版本、两个无发布坐标的原事件，以及 18 条带原跳过原因和投递键的记录。篡改原因在暂存前被拒绝。恢复出的 Kestrel 仍公开第三修订，通过历史入口显示第二修订的责任版本 2。同一构建复验通过单条旧签名证明。默认和自定义站点作者的旧清单响应字节也在独立验证中保持一致。 [合并演练](../artifacts/legacy-null-release-history-f9fc6d7/merged-09fc9f8/) · [兼容性](../artifacts/legacy-null-release-history-f9fc6d7/native-suite-status-1.txt)
- 同口径全仓为 208,737 NCLOC，超过原上限 191 行。更广的旧责任历史、整库证明迁移及公开验证、正式数据切换和容量仍需完成。 [规范化计量](../artifacts/legacy-null-release-history-f9fc6d7/merged-09fc9f8/code-volume.json)

开发提交 `d3e3d91` 复用站点身份和发布的实库夹具，合并版 21 项通过。全仓计量为 208,687 NCLOC，仍超过原上限 141 行。 [合并版实库](../artifacts/native-identity-fixture-09fc9f8/merged/combined-native.log) · [规范化计量](../artifacts/native-identity-fixture-09fc9f8/code-volume.json)

## 开发提交 `bbbde62`

- v5 离线恢复支持同一历史修订的最多八个连续责任版本，已用四版、四条原事件和 36 条原投递记录演练。另一条演练从 PostgreSQL 源表直接读取三条发布证明，按两个已审核旧公钥验签并保全恢复前后的原字节。坏前序、坏投递原因、签名和公钥篡改均被拒绝。透明日志、权利证明和公开历史验签待完成。 [历史恢复](../artifacts/goal-original-9ebbbeb/migration-history/) · [源表证明恢复](../artifacts/goal-original-9ebbbeb/migration-proof/)
- 管理员评论修订接口沿用 v1 AEDS 222。实库和 Kestrel 验证编辑、原文、删除收据、分页位置及摘要，以及公开域、缺少权限和撤权拒绝。首次实库发现 SQL 列名不明确，修正后受影响的检查通过。 [首次日志](../artifacts/admin-comment-revisions-9ebbbeb/first/postgres.log) · [合并验证](../artifacts/goal-original-9ebbbeb/native/combined-native.log)
- 375px Chrome 通过本地 FsusUI 正文查找、替换并保存。DOCX 和 EPUB 的即时及异步多图导出核对了图序、包内引用和下载字节。四种既有结构停服升级、旧产物与摘要 26 项保持一致。Debian ARM64 的真实签名 Worker 和 Chrome 验证取消时撤回未消费授权，新确认仍可运行。 [正文查找](../artifacts/goal-original-9ebbbeb/chrome-editor/editor-readiness-result.json) · [多图](../artifacts/goal-original-9ebbbeb/lanes/portable-images-chrome.json) · [插件](../artifacts/goal-original-9ebbbeb/lanes/plugin-consent-chrome.json)
- 锁定 Release、140 项 Core、141 项协议、C#、C++、Wasm 向量、3,847 项差分和 22 项定向 PostgreSQL 通过，含真实 PDF。Vue 与 Vite 使用原 FsusUI 源码 alias，三个 Wasm 字节一致。同口径代码量 209,192 NCLOC，超过原上限 646 行。封存包仍使用已有正式结果，四轮短档仅一轮通过，900 秒正式长测待执行。 [合并证据](../artifacts/goal-original-9ebbbeb/) · [计量](../artifacts/goal-original-9ebbbeb/code-volume.json)

## 开发提交 `bf80cb6`

- 复用 C# 与 TypeScript 编解码生命周期，独立比对了 71 种记录的 213 个字节样本、142 个 C# 帧绑定和 220 项 TypeScript 导出声明。省去默认同名的 frame 字段后，三个生成文件逐字节一致。七类管理员 Passkey 验证的目录签名与变更前逐字节一致。顶层评论与回复继续使用各自的 PoW 范围与会话规则，共用请求执行。 [协议对照](../artifacts/goal-followup-76bb581/lanes/independent-wire.log) · [目录签名](../artifacts/admin-step-up-schema-76bb581/shape.sha256) · [实库评论](../artifacts/comment-submission-reuse-76bb581/combined-native.log)
- 真实 Caddy TLS 和 Chrome 验证了管理员切换根评论证明时限、回滚、旧代挑战拒绝及只消费一次的新证明。首次运行遗漏启用站点管理夹具的参数，保留了审计空结果和停止后的维护库，补齐参数后仅复跑同一个场景。 [首次记录](../artifacts/goal-followup-76bb581/root-pow-chrome/) · [通过记录](../artifacts/goal-followup-76bb581/root-pow-chrome-retry/chromium/root-comment-pow-policy.json)
- 已就绪的文档任务可下载包含源修订、按序图片、格式、提供方及产物 SHA-256 的回执。发出前复核当前授权、原输入和产物字节。PDF 回执另核对原工具摘要。桌面及窄屏 Chrome 均通过，旧提供方 26 项产物或摘要一致。 [导出回执](../artifacts/goal-followup-76bb581/lanes/document-receipt-chrome.json) · [真实 PDF](../artifacts/goal-followup-76bb581/lanes/document-receipt-pdf.log)
- 旧 PostgreSQL 归档恢复并保全三条 V1 发布日志及签名检查点原件，篡改签名、链、坐标或公钥会被拒绝。独立演练恢复并启用文本、数值、布尔及日期四类审核过的旧属性定义，重复审批得到相同摘要。已恢复的 Kestrel 向当事作者返回原 ID、版本及摘要，拒绝匿名和其他作者。权利证明相应的完整 outbox、旧公开验签、旧审计签名和生产切换待完成。 [透明链](../artifacts/goal-followup-76bb581/anchored/) · [属性恢复](../artifacts/goal-followup-76bb581/property/) · [属性 HTTP](../artifacts/legacy-property-activation-76bb581/kestrel-probe.log)
- 确认原生 FsusUI 命令面板在输入法组合期间会把 Enter 误当作执行命令。已提交 issue 和公开复现步骤，命令面板接入留在隔离分支。 [FsusUI #1083](https://github.com/Ozwasyd/FsusUI/issues/1083) · [复现说明](https://github.com/Ozwasyd/FsusUI/issues/1083#issuecomment-6900787751)
- 锁定 Release、140 项 Core、141 项 Node 协议及 C#、C++、Wasm 验证通过。最终定向 PostgreSQL 14 项通过，含真实 PDF、Caddy、属性和签名日志。构建仍使用本地 FsusUI，三份 Wasm 字节一致。同口径代码量为 208,832 NCLOC，超过原上限 286 行。封存候选及容量结果继续沿用，四轮短档仅一轮通过，900 秒正式长测待执行。 [合并证据](../artifacts/goal-followup-76bb581/) · [计量](../artifacts/goal-followup-76bb581/code-volume-bf80cb6.json)

## 开发提交 `7f9841b`

- v5 从恢复的 V1 PostgreSQL 核验并保全第三次回滚发布的一条 READY 权利证明、父发布证明和四叶检查点。独立运行库再次备份恢复后，4 条原事件、31 条终态投递和证明原件一致。错误签名或投递摘要在暂存前被拒绝，原隔离候选仍不能启动。 [实库演练](../artifacts/goal-closure-a7fd1df/rights-migration/legacy-runtime.O0iUDwTF/run.txt)
- 公开历史接口提供三条 V1 发布证明和混合透明链。独立 OpenSSL 校验签名、检查点和四条日志记录，篡改、密钥封禁或撤回文章后返回 404，重启前后响应一致。第一次回放缺少信任配置，补齐后仅重跑该场景。旧权利证明公开验签、多条权利证明、跨文章长链和生产切换仍待完成。 [接口复验](../artifacts/goal-closure-a7fd1df/historical-archive/http-replay.XGnAlx4t/run.txt) · [首次记录](../artifacts/goal-closure-a7fd1df/historical-archive/http-replay.IC5Y1oC2/first-server.log)
- 即时与排队 PDF 能按序嵌入同一保存修订的 1 至 4 张授权图片。同平台两种产物逐字节一致。macOS、Debian ARM64 和桌面、375px Chrome 均有实测。Debian 首次运行因归档丢失 Fontconfig 目录时间戳的纳秒精度而失败，改用保留原精度的归档后通过，归档摘要为 `8fad25dce7829b4bdf079d5092db64d921d728d4ef1b0d14195bb7feefbbd841`。切换工具前需处理旧 PDF 队列。 [Chrome](../artifacts/goal-closure-a7fd1df/lanes/pdf-images-chrome.json) · [Debian 独立证据](../artifacts/goal-closure-a7fd1df/debian-pdf-worker/proof.sha256) · [首次日志](../artifacts/goal-closure-a7fd1df/debian-pdf-worker/first-runtime-failure.log)
- 管理员审核时间线覆盖提交、审核、编辑、删除和申诉。实库核对授权、撤权、文章范围与同一时间戳的版本顺序。「最近关闭」在服务器确认稿件删除后移除条目，Chrome 核对当前稿件、路由及焦点。 [实库](../artifacts/goal-closure-a7fd1df/native/combined-native.log) · [浏览器](../artifacts/goal-closure-a7fd1df/lanes/workspace-split.json)
- 锁定 Release、严格 Vue、Vite、三份本地 FsusUI Wasm 字节对照、140 项 Core、141 项 Node 协议、C#、C++、Wasm 向量、3,847 项差分和合并版 9 项定向 PostgreSQL 测试通过。共用 CLI、SQLite 暂存和 Inbox 夹具一共减少 300 行。新增功能纳入后合计 209,602 NCLOC，超过固定上限 1,056 行。 [合并检查](../artifacts/goal-closure-a7fd1df/) · [计量](../artifacts/goal-closure-a7fd1df/code-volume-7f9841b.json)
- 正式容量沿用封存候选 `f303f5c` 的四轮短档结果，仅一轮通过，900 秒独占长测尚未运行。C11 两项固定公开搜索仍未通过。 [容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收) · [固定查询用例](issues/risk-scale-query-cases.md)

## 开发提交 `1b7a38e`

- v5 恢复并启用首次发布与第三次回滚发布的两条旧权利证明。实库与 Kestrel 核对五叶检查点、5 条原事件、41 条投递以及备份恢复后的原字节。合并版公开档案在第三修订仍公开时可读取第一和第三修订，OpenSSL 独立验签通过。篡改、封禁或撤回均拒绝读取。更长的链、其他历史修订和生产迁移仍待完成。 [迁移恢复](../artifacts/legacy-v1-historical-rights-8b4e350/legacy-runtime.vzp0Q7LL/run.txt) · [合并版公开验签](../artifacts/goal-next-8b4e350/historical-rights/http-replay.ez8UxzR8/run.txt)
- 管理页可按文章与评论 ID 查询审核时间线。首次实跑发现 Caddy 遗漏两条历史读取路由，补上精确 GET 规则后，真实 Chrome 验证键盘查询、窄屏、精确长 ID、公网来源拒绝和撤权。 [合并浏览器](../artifacts/goal-next-8b4e350/moderation-chrome-combined/admin-identity-result.json) · [首次失败日志](../artifacts/goal-next-8b4e350/moderation-chrome.log)
- 独立管理员可创建分类、改名和修改描述。使用原管理员授权和绑定分类操作的 PoW。实库核对旧 ID、已发布与私有修订关联、冲突及公开代次。Chrome 验证开启及默认关闭的配置，旧库停服安装可重复执行。 [原生与浏览器](../artifacts/goal-next-8b4e350/lanes/admin-category/) · [安装方式](product/admin-taxonomy.md)
- 作者可从已保存附件选取最多四张图片导出。Chrome 实测桌面及 375px 的三选二与五选四，核对即时和排队 HTML 字节、回执内顺序，以及切回同一选择时避免重复排队。 [浏览器结果](../artifacts/goal-next-8b4e350/lanes/export-image-selection/article-media-browser.json)
- 复用集成数据库期限和停止流程净减 137 行，66 项定向原生测试通过。停机迁移和早期结构检查复用净减 159 行，原生验证旧版本、WebP 约束和准入顺序。锁定 Release、严格 Vue、Vite、140 项 Core、141 项 Node 协议及 3,847 项差分均通过。纳入新增功能后共 210,422 NCLOC，超出原上限 1,876 行。 [集成复用](../artifacts/goal-next-8b4e350/lanes/native-test-reuse/) · [迁移复用](../artifacts/goal-next-8b4e350/lanes/stopped-migration-reuse/) · [计量](../artifacts/goal-next-8b4e350/code-volume-1b7a38e.json)
- 同一旧封存包在完整 s、m 的隔离副本通过唯一标题词、正文词和空对照。原固定试词的两项搜索失败仍保留。正式容量沿用 `f303f5c` 的四轮短档，1 次通过，900 秒独占长测尚未运行。 [补充查询证据](../artifacts/c11-singleton-atoms-01f1904/README.md) · [容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `1688602`

- 管理页新增跨作者活动文章与回收站。真实 Caddy TLS 和 Chrome 核对两个所有者的 22 篇活动文章、原生续页、摘要搜索、一篇回收站记录、375px 界面及来源和权限拒绝。正式归档仍可由原流程重新发布。旧列表帧、管理员恢复、批量管理和永久删除仍待实现。 [合并版浏览器](../artifacts/goal-next-8b4e350/inventory-chrome-final/admin-identity-result.json)
- 最终源码通过 Release、严格 Vue、Vite、三份 FsusUI Wasm 字节对照、140 项 Core、141 项 Node、原生协议向量与 3,847 项差分。五项合并 PostgreSQL 检查通过，涵盖分类、标签、权限、文章归属及摘要。两条旧权利证明在同一合并版重新恢复和独立验签。共 210,626 NCLOC，超出原上限 2,080 行。 [原生检查](../artifacts/goal-next-8b4e350/native-final/tests.log) · [验签](../artifacts/goal-next-8b4e350/historical-rights-final/http-replay.mOyJZTj8/run.txt) · [计量](../artifacts/goal-next-8b4e350/code-volume-1688602.json)

## 开发提交 `f42587b`

- 管理员可把其他作者的软删除文章恢复为原作者的私有稿件。Passkey 证明绑定文章、期望修订和命令键。真实 Caddy TLS/Chrome 与 PostgreSQL 验证了修改命令拒绝、断连重试回执一致、正文摘要、分类、资产引用和属性沿用，并核对只提交一条审计和一条恢复事件。停服升级可重复执行。首次验收发现 SQL 加载顺序问题，第二次发现浏览器夹具用错请求字节类型，两次日志均保留。V1 直接恢复公开状态仍需独立实现。 [恢复浏览器](../artifacts/goal-next-14355d2/restoration-chrome-final/admin-identity-result.json) · [原生升级及首次日志](../artifacts/goal-next-14355d2/lanes/admin-article-trash-restore/)
- 管理员可通过审核页面查看已保存评论原文、修改版本与 SHA-256。375px Chrome 核对真实编辑、键盘焦点和撤权。含 65 个版本的 PostgreSQL 夹具验证了 64 条首屏、精确续页与错误文章坐标拒绝。原无文章参数的响应字节一致。 [浏览器](../artifacts/goal-next-14355d2/comment-revisions-chrome/admin-identity-result.json) · [原生](../artifacts/goal-next-14355d2/comment-native/tests.log)
- 标签创建复用现有权限、请求证明、锁和 taxonomy epoch。原生及 375px Chrome 验证了规范化名称、已保留别名冲突、数字 ID、公开代次与保留查询参数的 301。Word 的可选第 2 版回执可显示 11 类格式提示、次数与首次出现位置。Word 的 5 项生成检查、3 项 PostgreSQL 检查以及桌面和窄屏 Chrome 通过，28 个比对样本保持一致，包括旧回执和实际 DOCX。 [标签](../artifacts/goal-next-14355d2/lanes/admin-tag-create/) · [Word](../artifacts/goal-next-14355d2/lanes/word-warnings/)
- 同一 V1 文章的三次发布与三份权利证明现可一起迁移并公开验签。实库保留 6 条事件、51 条投递和六叶检查点。旧审批重新计算逐字节一致并可继续启用。责任清单的响应正文保持原字节，只在验证通过后提供历史归档链接。六个归档经独立 OpenSSL 验证。更长或跨文章日志和生产切换仍待验收。 [迁移](../artifacts/legacy-v1-second-rights-14355d2/legacy-runtime.FsXwxmVm/run.txt) · [旧审批](../artifacts/legacy-v1-second-rights-14355d2/legacy-runtime.DvLWnvrI/approval-byte-compatibility.sha256) · [合并版验签](../artifacts/goal-next-14355d2/six-proof-final.log)
- TypeScript 串行化和具名接口共用同一字段定义，局部净减 976 行。独立比对了 213 个载荷、2,938 个畸形输入首错及 220 项类型导出。媒体与发布测试夹具复用净减 80 行，34 项原生回归通过。新增功能计入后为 210,994 NCLOC，超过上限 2,448 行。锁定 Release、严格 Vue、Vite、三份本地 FsusUI Wasm 字节对照、140 项 Core、141 项 Node 协议和 3,847 项差分通过。合并版 12 项 PostgreSQL 检查通过，3 项专用 PDF 夹具沿用既有证据。 [协议复用](../artifacts/goal-next-14355d2/lanes/ts-protocol/) · [实库](../artifacts/goal-next-14355d2/native-final/tests.log) · [完整计量](../artifacts/goal-next-14355d2/code-volume-f42587b.json)
- 固定来源 #2178 和 #2179 追加七项现有证据映射。完整同一语料正式链路、逐边回执和四状态冲突继续跟踪。原固定 C11 搜索失败和冻结候选四轮短档 1 次通过继续保留，正式 900 秒长测未运行。 [评论条款](issues/risk-comment-lifecycle.md) · [容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

## 开发提交 `96dde60`

- 管理员可从回收站重新发布经核验的原公开修订。真 PostgreSQL、Caddy TLS 和 Chrome 验证 Passkey 绑定删除修订与原发布、篡改请求拒绝、断连重试同回执、只产生一条审计及一条发布事件。演练将原公开修订 4 恢复为修订 7，随后保存的私有修订 5 始终未出现在 HTML、AEDS 或搜索中。旧库停服升级和原公开图片选择另有原生证据。V1 旧 PUT 契约仍待迁移。 [合并版浏览器](../artifacts/goal-next-f7d8255/restoration-chrome-final/admin-identity-result.json) · [实库坐标](../artifacts/goal-next-f7d8255/restoration-chrome-final/admin-article-archive-counts.txt) · [离线升级](../artifacts/goal-next-f7d8255/lanes/admin-article-trash-publication/native-upgrade.log)
- 迁移工具支持同一 RP 和原 origin 的普通 V1 账号，限单枚站点 Passkey 且无 MFA 或恢复权限残留。隔离 PostgreSQL 从源备份恢复并导入，目标再次备份恢复后，Chrome 用原凭据成功登录 V2，签名计数从源库 2 推进到迁移时 4、登录后 5。其他 origin 的有效签名和篡改签名均遭拒，重复审批安全返回原结果。多凭据账号及旧 MFA、恢复权限与生产切换仍待验证。 [合并版登录证据](../artifacts/goal-next-f7d8255/passkey-final/evidence.json)
- 已保存修订比较显示摘要、分类和标签差异。浏览器验证窄屏和 Escape，实库验证过期基准及错误会话拒绝。分类和标签新增活跃引用、仅历史引用及别名的只读检查。EPUB 回执和界面展示目录与语法高亮的两项限制，旧回执与产物兼容性有 30 项字节对照。 [修订比较](../artifacts/goal-next-f7d8255/revision-chrome-settled/property-history-result.json) · [引用检查](../artifacts/goal-next-f7d8255/lanes/taxonomy-dependencies/chromium-metadata.json) · [EPUB](../artifacts/goal-next-f7d8255/lanes/epub-warnings/proof.sha256)
- 共用 V1 透明日志签名编码，由固定 V1 签名器生成的两篇文章交错向量通过，移去相邻叶子和篡改坐标均被拒绝。保留六叶实库迁移和公开凭证字节。完整生产跨文章链与成员证明仍待验收。 [跨文章向量](../artifacts/legacy-v1-global-transcript/cross-article-signed-vector.json) · [公开实测](../artifacts/legacy-v1-global-transcript/http-replay.EBr6KmaD/run.txt)
- 锁定 Release、严格 Vue、Vite、140 项 Core、141 项 Node、C#、C++、Wasm 与 3,847 项差分通过。合并版定向 PostgreSQL 19 项通过，三份 Wasm 与本地 FsusUI 源码 alias 的产物字节一致。首次合并编译缺少三个新增帧的校验实现，补齐原补丁后无警告、无错误。总计 213,336 NCLOC，超出固定上限 4,790 行。 [实库](../artifacts/goal-next-f7d8255/native-final/tests.log) · [首次编译日志](../artifacts/goal-next-f7d8255/release-final-first.log) · [计量](../artifacts/goal-next-f7d8255/code-volume-96dde60.json)
- 封存包 `f303f5c` 的 SHA-256 已复核。短档容量依旧四轮仅一次通过，900 秒正式长测未运行，C11 两项固定查询仍失败。新增独立供给端证据准入校验，11 项离线检查通过，原始历史矩阵复算结果逐字节一致。本轮未执行正式负载。 [容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收) · [固定查询](issues/risk-scale-query-cases.md) · [准入复验](../artifacts/goal-next-f7d8255/lanes/private-admission/forensic-replay.log)

## 开发提交 `a4d1ee9`

- 原 C11 s、m 的标题和正文试词均复跑通过。四个原请求各只返回原文章 1。两个不存在的对照均为空。仅在副本补齐当前必需的摘要列，整个数据归档在排除此全空列后摘要一致。旧冻结包及失败证据继续保留。 [固定 s、m 复跑](../artifacts/c11-fixed-search-a19a819/README.md) · [当前查询规则](product/fas4-search.md)
- 历史对话框可比较当前未保存的标题、Markdown、摘要及分类标签。真实 Chrome 在桌面和 375px 验证了本地比较、已保存响应字节一致、脏稿仍限制恢复。独立头图字段及对应差异仍待交付。 [合并版浏览器](../artifacts/goal-next-a19a819/editor-chrome-merged/property-history-result.json)
- 同站点普通账号可在一次审批中接续一至五枚 Passkey，也可在同一停服副本追加另一个独立审批的账号。实库与 Chrome 分别验证了两枚凭据各自登录、两种账号导入顺序、账号序列保留或推进、原凭据和已撤销主体不变，以及拒绝无效证明或冲突。原单凭据审批和回执兼容。MFA、恢复权限、管理员凭据和生产切换仍待完成。 [多凭据合并版](../artifacts/goal-next-a19a819/passkey-merged/evidence.json) · [连续导入合并版](../artifacts/goal-next-a19a819/passkey-additive-merged/evidence.json) · [反向顺序](../artifacts/legacy-site-passkey-a19a819-additive/advance/evidence.json)
- 两篇文章可共用一个经独立核验的 V1 全局链。实库保全一个回滚链和一个普通首发的原始记录。合并版从备份恢复，OpenSSL 独立核对四个发布证明、权利证明及父发布的 Merkle 路径。归档外层 v2 只公开所请求成员及兄弟摘要，原 V1 签名字节和旧单文章归档均保持一致。首次合并复跑遗漏校验夹具，补齐后通过。大批次和更多生命周期组合仍待覆盖。 [合并版验签](../artifacts/goal-next-a19a819/lanes/global-v1-proof/global-http.oKjfJCRI/run.txt) · [首次日志](../artifacts/goal-next-a19a819/lanes/global-v1-proof/replay-merged-first.log) · [旧单文章复验](../artifacts/legacy-v1-global-custody/http-replay.iFXj926J/run.txt)
- 锁定 Release、Vue、Vite、140 项 Core、141 项 Node、3,847 项协议差分和三份本地 FsusUI Wasm 字节对照通过。另通过 8 项检索、10 项定向实库和 2 项 Caddy TLS 检查。共用测试夹具范围净减 188 NCLOC。纳入本轮功能后总计 213,751 NCLOC，超过原上限 5,205 行。 [检索](../artifacts/goal-next-a19a819/fas4-native-merged/tests.log) · [实库](../artifacts/goal-next-a19a819/proof-and-fixtures-native/tests.log) · [Caddy TLS](../artifacts/goal-next-a19a819/native-checkpoints-tls/tests.log) · [计量](../artifacts/goal-next-a19a819/code-volume-a4d1ee9.json)
- 封存 `f303f5c` 归档 SHA-256 复核一致。四轮原短档容量仅一轮通过，900 秒正式长时验收未运行。 [原始容量矩阵](../tests/Performance/matrix-2026-11-15.md#封存候选-f303f5c-四轮独占验收)

在工作树中运行 `python3 -B tools/verify-release.py RELEASE_DIRECTORY`，可逐项核对归档内文件、三项原始 FsusUI Wasm、发布坐标及完整 Git 历史。验证从空 Git 仓库导入 bundle，并返回候选和 FsusUI 提交、归档文件数及历史提交数。应用用例由独立原生和浏览器入口验证。
