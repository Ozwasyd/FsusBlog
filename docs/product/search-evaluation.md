# 公开搜索相关性、延迟与能耗评估基准

> **角色**：评估契约与基准方法论
> **适用对象**：搜索维护者、性能优化负责人与发布评审者
> **权威依据**：评估配置、合成语料与评审标注以 [`tests/Performance/SearchEval/config.v1.json`](../../tests/Performance/SearchEval/config.v1.json)、[`tests/Performance/search_eval_dataset.py`](../../tests/Performance/search_eval_dataset.py) 与 [`tests/Performance/search_eval.py`](../../tests/Performance/search_eval.py) 为准。

---

## 1. 概述与范围

本文定义 FsusBlog v2 公开搜索的统一可复现评估框架，用于在推进分词统一、概念匹配与 BM25F、结果契约、块级剪枝、默认服务端检索、单飞缓存及增量段索引之前与之后提供同口径证据。

- **选择顺序（质量优先于能耗）**：必须先按**相关性指标**、**尾延迟**与**零非法拒绝/错误率**筛选候选实现，再仅在通过质量与响应门槛的实现之间比较能耗；拒绝请求或跳过工作绝不可改善单次检索能耗得分。
- **不包含范围**：本框架不引入新的外部搜索服务或向量检索，不宣称任何架构在所有负载下具备普适能耗最优性，且不在非受控共享 CI Runner 上强制紧延迟或硬件能耗门槛。

---

## 2. 版本化数据集、来源与留出划分

所有评估资产均显式声明版本号并由 SHA-256 摘要校验（`python3 tests/Performance/search_eval.py verify-dataset`）：

| 资产 | 版本标识 | 说明 |
| --- | --- | --- |
| 评估配置 | `fsusblog-search-eval-config-v1` | 记录分析器/评分配置标识、暂定门槛、摊销场景与网络能耗估算参数 |
| 合成语料 | `synthetic-tech-blog-v1` | **420 篇**显式标注 `synthetic: true` 的中英文技术博客公开文章（跨越 **3 个 FSPK v4 分片页**：200 + 200 + 20），不含任何私有草稿或读者查询历史 |
| 查询集与标注 | `synthetic-queries-v1` / `synthetic-judgments-v1` | **360 条**合成查询，按 12 类查询等比例分层划分为 **180 条调优集（`tuning`）** 与 **180 条留出集（`holdout`）**，每类各 15 条调优 + 15 条留出 |

### 12 类查询覆盖

`chinese_dict`（中文词典词）、`chinese_unknown`（未知中文复合词，含孤立单字干扰文档）、`chinese_names`（中文人名/地名/项目名）、`chinese_single_char`（显式单字查询）、`technical_identifier`（复合编号与驼峰标识符，含拆词干扰项）、`punctuation_sensitive`（如 `C#`、`C++`、`.NET`、`ASP.NET`、`HTTP/2`、`O(log n)`）、`simplified_traditional`（繁简中文双向互查）、`phrase`（引号短语与邻接短语，含乱序分散干扰项）、`mixed_language`（中英混合多概念）、`long_query`（6–12 词自然语言长查询）、`markdown_boundary`（可见标题/代码/链接文字 vs 隐藏 URL/HTML 注释/属性/脚本标签）、`no_match`（真实无命中及超长复合编号）。

---

## 3. 指标口径、暂定门槛与能耗方法论

### 3.1 相关性指标与等价性校验分离

- **人工/分级相关性评估（`tuning` 与 `holdout` 独立报告）**：计算 `nDCG@10`（0–3 分级标注）、`MRR@10`、目标文章 `Success@3`、`Recall@10` 以及 `expectedEmpty` 查询的误召回率 `noMatchFalsePositiveRate`，并按 12 类查询分桶汇报。基线缺陷原样记录，不改写预期以迁就旧行为。
- **优化与穷举等价性校验（独立段 `equivalenceChecks`）**：单独报告两个引擎或剪枝与穷举参考评估器在前 K 条上的精确排序一致率，与人类相关性评分严格隔离。

### 3.2 暂定规划门槛（Provisional Gates）

以下门槛在 [`config.v1.json`](../../tests/Performance/SearchEval/config.v1.json) 中显式标记 `provisional: true`，在目标部署硬件、施加负载与维护者复审标注冻结前仅作规划参考；任何修订必须在 `provisionalGates.revisionHistory` 记录理由：

| 指标 | 暂定门槛 | 说明 |
| --- | --- | --- |
| `holdout nDCG@10` | `≥ 0.85` | 仅使用留出集判定，禁止在留出集上调参 |
| `holdout targetSuccess@3` | `≥ 0.95` | 目标文章进入前三名比例 |
| `holdout noMatchFalsePositiveRate` | `≤ 0.05` | 真实无命中与隐藏 Markdown 查询不得大量误召回 |
| `serverLatencyP95MsMax` | `≤ 30.0 ms` | 服务端 P95 查询延迟（受控硬件复现） |
| `maxFailedOrRejectedRate` | `≤ 0.001` | 失败与拒绝请求比例上限；超限即失去质量达标资格 |

### 3.3 延迟、配对轮次与能耗核算

- **配对重复运行**：默认至少 3 轮，采用交替顺序（`server → local` / `local → server`），包含显式预热、空闲功率基线采样与测量自身开销校准，汇报均值、中位数、最小/最大、标准差与四分位距（IQR）。
- **分场景工况**：独立采集冷/热浏览器会话、缓存命中与未命中（重复热查询 vs 唯一查询）、稀有词与高频词、协作取消、多路并发吞吐，以及发布/编辑/撤回周转下的重建耗时与字节重写量。
- **能耗口径与局限**：
  - 区分**查询能耗**与**索引能耗**，按显式读写周转场景（`read_heavy_low_churn` = 10,000 次/发布、`balanced` = 500 次/发布、`high_churn` = 20 次/发布）摊销索引与空闲能耗。
  - 明确区分 `cpu_package`（Linux `/sys/class/powercap/intel-rapl*` 封装级计数器）、`whole_system` 与参数化网络传输估算（`networkEnergyEstimate`，标记 `isEstimate: true`，绝不混入实测计数器）。
  - **缺失探针绝不记为 `0`**：无可读硬件计数器时（例如非特权 macOS 或共享 CI 虚拟机），明确记录 `available: false`、`scope: "unavailable"`、原因说明与 `null` 数值。
  - **质量达标单次检索能耗（`joulesPerQualityQualifiedSearch`）**：仅当全部质量/延迟/低拒绝门槛同时满足时计算；否则为 `null`。

---

## 4. 当前基线实测结果（未改动运行时）

实测环境：基线提交 `40b8b560f0ef`，Apple M1 Pro（8 核，macOS arm64），.NET `10.0.404`（Release）、Node `v24.16.0`、PostgreSQL `18.7`、Google Chrome；3 轮交替配对。硬件能耗探针在非特权 macOS 上标记为 `unavailable`（不记为 `0`）。

### 4.1 相关性基线（留出集 `holdout`，180 条查询）

| 引擎 | `nDCG@10` | `MRR@10` | `Success@3` | `Recall@10` | `NoMatch FPR` | 拒绝请求 | 暂定门禁 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `server-fas4` | `0.9316` | `0.9202` | `0.9500` | `0.9656` | **`0.8000`** | `0` | **未通过**（误召回率超限） |
| `local-fspk-v4` | `0.9219` | `0.9103` | **`0.9250`** | `0.9563` | **`0.8500`** | `2`（超长查询） | **未通过**（S@3、FPR、拒绝率超限） |

- **服务端 vs 本地前 10 条精确排序一致率**：仅 **`75 / 360`（`20.83%`）**。
- **已确认基线缺陷类别**：
  - `markdown_boundary` 隐藏链接目标/HTML 注释/属性/脚本误召回率 **`1.00`**（双端均直接对原始 Markdown/HTML 文本分词）；
  - `no_match` 误召回率高达 **`0.733`（服务端）/ `0.800`（本地）**（并集单字召回与标点剥离导致无关文档大量命中）；
  - `simplified_traditional` 留出 `Success@3` 仅 **`0.467`（服务端）/ `0.333`（本地）**；
  - `punctuation_sensitive` 因剥离 `#`/`+`/`.` 出现 `C#`/`C++`/`.NET` 与普通单字母噪声冲突；
  - `chinese_single_char` 本地留出 `nDCG@10 = 0.834` 明显低于服务端 `1.000`（跨 3 页局部 IDF 偏移与词典词内单字发射所致）；
  - `phrase` 服务端缺乏短语邻接验证（留出 `nDCG@10 = 0.952`）。

### 4.2 延迟、吞吐、构建与真实浏览器冷/热会话基线

| 维度 | `server-fas4`（3 轮中位数） | `local-fspk-v4`（3 轮中位数） |
| --- | --- | --- |
| 语料规模 | 420 篇 / 167,510 B 原文 / 2,277 词项 / 29,714 倒排 | 3 页 FSPK v4 / 445,099 B |
| 索引构建耗时（Wall） | `86.58 ms`（周转单次全量重建 P95 `18.77 ms`） | 本地客户端冷会话下载+校验首查 `6.27 ms`（零网络延迟模拟） |
| 查询 P50 / P95 / P99（全集） | `0.071 ms` / `0.608 ms` / `1.406 ms` | `0.207 ms` / `1.074 ms` / `1.453 ms`（热缓存） |
| 稀有词 P95 vs 高频词 P95 | `0.585 ms` vs `1.831 ms` | `1.033 ms` vs `1.218 ms` |
| 4 路并发吞吐 | `26,918 QPS`（0 失败） | `1,741 QPS`（0 失败） |
| 真实 Chrome 冷首查耗时 / 传输字节 | **`52.22 ms`** / **`7,286 B`**（0 Worker、0 分片请求、0 IDB） | **`111.88 ms`** / **`445,099 B`**（1 Worker、3 次分片 GET、`fsusblog-v2-compact-search-v1`） |
| 真实 Chrome 热续查中位数 | `33.02 ms` | `35.54 ms` |
| 硬件 CPU/整机能耗 | `unavailable`（非特权 macOS 无 RAPL） | `unavailable`（非特权 macOS 无 RAPL） |

---

## 5. 验证与复现入口

```bash
# 确定性数据集校验与评估框架单元测试（常规 CI 自动运行）
python3 -B tests/Performance/search_eval.py verify-dataset
python3 -B -m unittest tests/Performance/search_eval_test.py -v

# 完整 Release 配对基线运行（输出机读 JSON 至 gitignored artifacts/）
dotnet build FsusBlog.V2.slnx -c Release --no-restore -warnaserror
python3 -B tests/Performance/search_eval.py run --rounds 3 --skip-build --out artifacts/search-eval-report.json

# 真实 PostgreSQL 18 + Chrome 冷/热浏览器会话对比
tests/Performance/search-eval-browser.sh artifacts/search-eval-browser
```
