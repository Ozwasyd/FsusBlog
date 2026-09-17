# Issue #1387 rolling Vitest cache 与 coverage 合同

Production rolling runner 只执行 `src/frontend/node_modules/vitest/vitest.mjs`，不经过 `npx` 或 npm 配置解析。authoritative catalog 发现后，独立 no-test coverage 过程用 `coverage.all=true` 生成全零命中的 universe；普通 unit/property/model host 均使用 `coverage.all=false`，最终只把各 partition hit map 合并进该 universe。

coverage universe 同时预热 run-bound transform cache。runner 随后生成绑定 source commit/worktree fingerprint、Node/Vitest/Vite、完整 config digest 与 transform environment 的 immutable base manifest。Linux 等支持 symlink view 的平台上，每个 host 只新增自己的普通文件 delta；不支持 symlink 时允许 `COPYFILE_FICLONE` fallback，evidence 必须明确记录 `cloneMode`。合并只遍历 delta，base manifest 污染、base link 缺失/越界、delta executable 冲突、zero-hit universe 出现命中、JSON/JUnit 数量不一致均 fail closed。

`PasskeyRegisterModal.test.ts` 的 Production fresh 失败发生在测试开始前：动态 import 的 `beforeAll` 达到原有 30 秒上限，同时失败 host 的 transform/import 分别累计 107/124 秒。修复不提高 timeout；该文件用 `@fsusblog-vitest-host max-workers=1` 声明实测资源边界，planner 将它放入单文件 partition，coordinator 只在其他 host 全部 settlement 后为它开放独占单 worker admission window。pragma 不增删 test ID，也不改变 coverage scope。isolated perf 仍在 ordinary runner settlement 后由独立无 coverage profiler 的进程执行。

summary 必须保存：immutable base file/byte count 与 manifest digest；每个 host 的 base bytes、delta files/bytes、clone mode、journal/merge traversal count；zero-hit universe file count/digest/process startup；coordinator JSON/JUnit merge input count 与零额外 process startup；规范化 coverage hit-map 的文件数与 digest。hit-map 保留 statement/function/branch instrumentation 位置，只把正命中次数压成 `1`，因此随机调用次数不会伪装成 coverage scope 漂移，而任何位置变化或 hit/unhit 变化仍会改变 digest。raw JSON/JUnit/blob/coverage shard 继续保留。

## 同机三轮证据

source commit 固定为 `4f8e69540c710659feb1539848459d4996b49c9a`，两组都使用相同的 217 文件、1491 authoritative test ID、确定性 partition 和 Passkey 独占调度。before 仅保留旧物理路线：每 host 全量 reflink clone、每 host 全树 merge、执行 partition 承担 universe、Vitest blob merge。after 使用 immutable symlink base、write journal delta、独立 zero-hit universe 和 coordinator merge。

| 路线 / 轮次 | wall ms | Vitest 启动 | cache copied bytes | merge traversal | settlement tail ms |
|---|---:|---:|---:|---:|---:|
| before 1 | 494000 | 8 | 251894124 | 32698 | 207632 |
| before 2 | 478670 | 8 | 251894124 | 32698 | 206150 |
| before 3 | 485470 | 8 | 251894124 | 32698 | 193072 |
| after 1 | 470430 | 8 | 0 | 14224 | 199788 |
| after 2 | 457686 | 8 | 0 | 14224 | 196380 |
| after 3 | 487773 | 8 | 0 | 14224 | 197025 |

三轮均为 217/217 文件、1491/1491 ID exact-once。均值从 486047 ms 降到 471963 ms；host base 复制从每轮 251894124 bytes 降到 0；merge traversal 从 32698 降到 14224；settlement tail 均值从 202285 ms 降到 197731 ms。Vitest 启动总数仍为 8，但组成从 catalog + 6 host + 1 blob merge，变为 catalog + 1 zero-hit universe + 6 host；report merge 不再启动 Vitest。

after 三轮的 partition identity 集合、coverage 汇总和 439 文件 hit-map digest `c499f611a36f747790fff1f3efad885d31e9bf2e1a12db95e65744a64a4fc72a` 完全一致；lines 11320/26285、statements 11944/28811、functions 2366/7213、branches 6963/17740。验证过程还暴露并修复了 blind-RSA 测试每轮动态生成密钥导致的 coverage 分支漂移，测试现在导入固定测试密钥并使用确定性 blind 随机源。

旧 runner 的 439 文件集合与最终集合一致，但旧的“执行 partition 同时生成 universe”只产生 26259 lines / 28750 statements / 7173 functions / 17727 branches；它依赖该 partition 恰好加载的模块形态，是不完整且不可重复作为 instrumentation 权威的过时基线，不应为了数字相同而继续保留。独立 no-test universe 修正为完整 instrumentation 后，三轮 scope 与 hit-map 均稳定，coverage 阈值仍全部通过；这是基线纠正，不是业务代码 coverage 回退。

回退时可把 host limit 收缩到诊断值，或在 symlink 不可用的平台进入有 evidence 的 reflink fallback；不得恢复 `npx`、把 `coverage.all=true` 放回执行 partition、提高 hook timeout，或复用不同 source/toolchain/config 的 base。任何 base/delta/universe 校验失败都应重跑本轮 fresh producer，无需重启应用服务。
