# v1 代码量基线（V2-002）

参考提交 `2605b438eed8f16d12ddddf033d08a6fa18fcd12`，Git tree `ae47acb5a24a336546abf4756bfdd93e57c9f740`。2026-11-14 以只读方式复核 `master` 和提交内容；计量读取 Git 对象，不使用本地 v1 工作树中的未提交文件，也没有构建、运行 v1 或复制 v1 的提交历史到 v2。

见 [机器可读数据](baseline-v1.json) 的 `total`、`by_category`、`by_area` 和排除项。**90% 是功能齐全之后的验收目标，不使用不完整切片的比例宣布达标。**

| 类别 | 手写 NCLOC | 生成 NCLOC | 合计 NCLOC |
| --- | ---: | ---: | ---: |
| 生产实现 | 491,499 | 9,539 | 501,038 |
| 产品 schema 与规则 | 170,072 | 101,171 | 271,243 |
| 测试代码与规则 | 812,621 | 3,018 | 815,639 |
| 工具、运维、生成器与工程规则 | 497,500 | 44 | 497,544 |
| **主口径合计** | **1,971,692** | **113,772** | **2,085,464** |

主口径共 6,728 个文件，2,029,051 原始 NCLOC、94,039,132 源字节、18,059,223 词元近似。**减量 90% 的 v2 总上限为 208,546 NCLOC**。另有 32 个历史替代凭证/留存快照，若把这些也算作治理输入，共 2,225,069 NCLOC；不以偏大的基线计算上限。两项故意非法的格式治理 fixture（重复 YAML/JSON key）按原格式计量，零未映射路径。

复算：

```bash
export CODE_VOLUME_CLANG_FORMAT="$(xcrun --find clang-format)"
python3 tools/code-volume.py --repo ../FsusBlog --rev 2605b438eed8f16d12ddddf033d08a6fa18fcd12
python3 tools/code-volume.py --repo . --rev HEAD
```

v1 指令要求引用提交已在指定 Git 对象库中。取样时它不在 v1 原有工作树的对象库中，读取的是另外创建的临时 bare 仓库及其只读 alternates（`GIT_ALTERNATE_OBJECT_DIRECTORIES`）。也可以将 `--repo` 指向一份含此 SHA 的其他本地副本。`--rev :index` 将 Git 暂存区冻结为 tree 并统计这一个 tree；不读取未暂存的文件。探针用同一份小型 Git fixture 测得 `:index` 和提交的 tree、分类和各项计数一致，验证生成文件、schema、测试素材、`tools/coverage` 和第三方排除。

工具链：Git `2.54.0`、Python `3.9.6`、Node `v24.16.0`、Prettier `3.8.1`（读相邻 FsusUI 安装目录；也可用 `CODE_VOLUME_PRETTIER_ROOT` 指定已经配好的同版目录）、Apple clang-format `21.0.0`、shfmt `3.13.1`、Ruff `0.15.17`、系统 xmllint/libxml2 `2.9.13`。不从被测仓库载入 formatter 配置或插件。输出固定 UTF-8；不可解码的源失败并给出路径。使用同一工具链及口径，可将输出绑定 tree 和锁文件版本。`raw_ncloc` 统计原始物理行，`ncloc` 统计正常格式化后的物理行，二者均去空行和可识别注释。`bytes` 是入选原 Git blob 字节数。`token_proxy` 计算去注释的字词/标点单位，是可复算的词元近似，不是各语言编译器的 token；不用于 90% 判定。

- JS/TS/Vue/CSS/HTML/YAML 使用 Prettier 100 列（对象折叠以免源换行影响），C#/C++ 使用 clang-format Microsoft 风格 100 列并展开短函数，Shell 使用 shfmt，Python 使用 Ruff，XML 使用 xmllint；JSON 数据统一二空格缩进。其他文本采用源格式。格式化失败保留原写法并记录原因，不能排除此文件。注释剥离属轻量词法策略；如在新语言或特殊字面量（例如正则、原始字符串、heredoc）发现误差，先补边界用例，然后按同一新版工具同时重算 v1/v2。
- 自有业务、测试、可执行测试夹具、构建及运维脚本、生成器和生成代码均入选；schema、配置、仍参与规则判断或执行的测试 fixture 和治理规则单列并计入总量；`test-replacement-{transactions,receipts}` 和 `test-retention-{before,replacements}.json` 这一类历史凭证/快照单列，其重复编目不进入较严格的主口径。`generated` 标签只建立分账，不改变总数。没有把普通 fixture 或整个 `dist`、`coverage` 目录按名字清空。还原工具生成的依赖锁快照、纯说明文档与文档报表、二进制、字体、第三方 vendor、运行缓存和纯编码测试向量不纳入源代码口径。保留在仓库的 OpenCC 字典通过其上游署名识别为第三方；完全自有的策略和搜索词典入选。没有映射的扩展单列，新增语言或资产进入仓库时先审计这张表。
- FsusUI 属于 v1 已有依赖，两个版本都不把整棵 FsusUI 计入。若将 Blog 行为挪到 FsusUI 或其他项目，要把归属改动以同口径另计并加回 v2；当前没有这样的 v2 外移增量。最终比较先冻结 FsusUI 引用并审查从基线至该引用的差异；每项归因应含外部仓库、commit、路径/范围、归因理由和同口径计数，有增量时把独立报告与 v2 计数相加。源码路径迁移、生成新格式、归类为测试或删注释均不是减量方式。
- `by_area` 支持按 v1 工程与 v2 业务切片对账。首条复杂链路要把身份与会话、写入/发布、公开读、前端、协议、测试分别实测，再复估其余编辑、插件与迁移；不要从某个简单模块的比率外推。最终应分别比较生产、测试和工具、手写、生成、字节、词元，总预算公式为 `1 - v2_owned_source / v1_owned_source`。
