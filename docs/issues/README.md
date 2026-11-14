# V2-001：开放 issue 输入与需求处置

v1 代码参考为 `2605b438eed8f16d12ddddf033d08a6fa18fcd12`。issue 单独按 GitHub 当前状态取样，状态和更新时间以采集窗口为准。仓库已归档；GitHub API 查询和独立交叉检查都是只读。v1 原有 issue、评论和 PR 的交接、分支、权限或测试文字仅作为研究输入。

2026-11-14 20:35–20:43（北京时间）的归档包括 808 个开放 issue、2,562 条评论。820 个开放 PR 未计入；21 页顶层游标和各子连接均走到末页。GraphQL 正式关联记录有 174 个被阻塞端、133 个阻塞端、50 个子项和 42 个父项；正文/评论另有 3,516 条规则匹配的文本候选。独立 REST 清单的 808 条身份、状态、时间和正文一致，但七项计数少 40 条评论；对这七项请求独立 REST 评论连接，所得条数全部与 GraphQL 相符。

808 个 issue 已有议题级处置及验收草案。重点九项有较细的子条款记录，其余条目也按需求族归并。2,303 条评论已关联处置，其中部分旧交接按明确的历史标识或逐字相同的内容分配。259 条评论、自由文本依赖、已关闭父项及跨仓依赖的影响仍待复核。完整 P0 退出条件仍未满足。

- [census.json](census.json)：采集起止时间、GitHub 报告的 issue/PR 独立计数、顶层游标链、子连接分页和内容可校验摘要。[rest-crosscheck.json](rest-crosscheck.json) 单列独立 REST 清单比较和评论计数差异。
- [inventory.tsv](inventory.tsv)：按编号列出开放 issue、状态、更新时间、标签、评论数，以及 GitHub 结构化的 blocked by / blocking / parent / sub-issue。只计算 GitHub Issue，排除 Pull Request。
- [open-issues.ndjson.gz](open-issues.ndjson.gz)：开放 issue 正文与评论快照。只存公开可见读取结果，不保存登录凭据。不是测试 fixture、命令或运行配置。
- [text-reference-candidates.tsv](text-reference-candidates.tsv)：正文/评论中显式 `Depends on:`、`Parent:`、`Implementation DAG:` 等行的候选。候选带正文/评论 URL 和文本行号；目标可能是 PR、关闭 issue、跨仓 issue 或历史引用。在段落、表格或自由文本里的依赖仍需人工回查。正式关系与文本提及不能混用。
- [review-queue.tsv](review-queue.tsv)：按开放 issue 索引处置台账；没有映射的主题路由只是分工建议，`acceptanceCase` 的 ID 关联下方的现有条款。若一个 issue 对应多种处置，按分项台账判断。去重覆盖和剩余条款见 [review-progress.json](review-progress.json)。
- [accepted-priority.tsv](accepted-priority.tsv) 与 [priority-review.md](priority-review.md)：附件九项的子条款、测试映射和剩余边界。
- `review-<起始编号>-<结束编号>.tsv` 各文件是 issue 范围处置及验收草案；评论没有完成逐条裁决的范围在各表列明。
- `comments-*.tsv` 关联冻结评论、处置及相应验收。详见 [评论覆盖与未处置 issue](comment-progress.json) 和 [从评论纳入的验收用例](comment-findings.md)。
- [scope-families.md](scope-families.md)、[memory-review.tsv](memory-review.tsv) 和 [conflicts.md](conflicts.md)：新增范围、硬件要求和实施冲突。

可离线重建候选索引并验证采集完整性：

```sh
python3 tools/issue-index.py
```

如需在新窗口重新采集，指定另一个目录保留当前快照。第二种 API 可交叉验证状态、更新时间、正文及评论条数：

```sh
dest=$(mktemp -d)
python3 tools/issue-census.py --output "$dest"
gh api --method GET --paginate 'repos/Ozwasyd/FsusBlog/issues?state=open&sort=created&direction=asc&per_page=100' \
  --jq '.[] | select(has("pull_request")|not) | {number,updated_at,state,comments,body}' > "$dest/rest.ndjson"
python3 tools/issue-index.py --input "$dest" --independent-rest "$dest/rest.ndjson"
```

证据冻结检查 GitHub 提供的全部游标走到末页、每个 GraphQL 评论连接的实际数量和唯一 ID，并通过 REST 清单独立核对 issue 集合、状态、更新时间与正文。REST 的清单级评论计数有差异时另行记录，不用较低计数丢弃已获取的评论。P0 的完成标准还包括逐项读正文、评论和依赖，解决冲突，给所有采用的条款映射场景、模块与预算。条款进度单列；若运行证据缺失，不能据快照或主动评审宣布产品验收。
