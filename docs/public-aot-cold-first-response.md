# 公共 AOT 冷首屏与切流门禁

## 生产契约与 SLO

`seoEligible` 公共 URL 在生产环境的第一次 `GET` 必须满足且只允许以下结果之一：

- `200`：`X-Fsus-Public-Aot-Source: server-ssr`、`X-Fsus-Public-Aot-State: fresh`，正文位于 `<main>`，并包含 title、description、canonical、robots、Open Graph、Twitter 与可解析 JSON-LD；响应同时声明 renderer、frontend asset、release 和 slot 身份。
- `503`：后端正在生成或暂时无法生成该 URL，响应必须带正整数 `Retry-After`、`Cache-Control: no-store`、`X-Robots-Tag: noindex`、`X-Fsus-Public-Aot-Source: server-status`。该响应不得包含可被误判为完整页面的空 SPA 壳。

不存在的内容返回 `404`，永久移除内容返回 `410`。二者不是冷缓存回退，也不能被预热程序重试成成功。目标 SLO 是冷首屏契约符合率 100%，可重试 `503` 在预热窗口（默认 15 秒）内收敛为完整 `200`；未收敛时禁止切流。

## 冷缓存与变更路径

生产缓存未命中时，`PublicAotShellService` 先完成路由/资源分类，再排队 backfill，并向当前请求返回可重试失败。旧的空 SPA `200` 只保留给开发源资源模式，不是生产降级路径。

文章新增、编辑、删除以及分类、标签、归档关系变化均通过既有失效入口清除对应 AOT 条目。失效后的第一个请求重新遵守上述 `200/503/404/410` 契约；旧 HTML 或旧 hydration sidecar 不得冒充新内容。frontend asset version 改变时，旧版本缓存条目不兼容，必须为新版本重新生成。

## 发布前全量预热证据

`release-rollout.sh` 在 `candidate-smoke` 阶段、`gateway-switch` 之前对 candidate 的全量 manifest 执行 `warm-public-aot-cache.mjs --scope all --fail-fast`。并发数继续由机器 CPU、内存和显式上限动态计算，不写死 worker 数。

证据写入 `public-aot-warm.json`，包含：

- manifest 全量路由及其 SHA-256 摘要；
- 每个 URL 的第一次响应和最终响应：status、source、state、Retry-After、cache/noindex；
- renderer、frontend asset、release、slot 身份；
- title、description、canonical、robots、Open Graph、Twitter、JSON-LD 和 `<main>` 正文检查；
- 首次响应和收敛耗时、生成时间、canonical origin 与 scope。

`verify-public-aot-warm-evidence.mjs` 对报告做独立复验。以下任一情况都会以非零退出码阻断 candidate smoke，因此不会进入流量切换：报告缺失或过期、scope 不是 `all`、manifest 摘要不匹配、路由覆盖缺失/重复、第一次响应违反契约、最终响应不完整、版本身份不唯一、release/slot/canonical origin 不匹配。

## 观测与排障

HTTP 响应头用于逐请求区分 `server-ssr/fresh`、`server-status/transient-failure`、`not-found` 和 `gone`。现有 Public AOT 指标记录 render source、outcome、backfill 结果和耗时；runtime health 同时暴露 worker probe、队列、熔断与 route quarantine。排障时先按 URL 对照预热证据，再检查 backfill failure、DB gate、Redis/cache 和 SSR worker 状态，不能只看最终的一个成功请求。

## 回滚与无重启降级

切流前失败时保持 candidate 不承接公网流量，修复数据、缓存、worker 或资源后重新执行 candidate smoke；不得跳过或手工改写证据。若内容变更后出现瞬时失败，继续返回可重试 `503`，待 backfill 恢复后自动回到完整 `200`，不需要重启进程。

若切流后确认新 release 的公共 AOT 持续异常，按既有 gateway rollback 将流量切回仍在保留窗口内的上一 slot/release，并保留失败 candidate 的证据用于诊断。回滚目标仍必须通过自己的 release/slot、资源兼容性与公共 AOT 契约验证；任何情况下都不得把空 SPA `200` 作为降级方案。

## 验证覆盖

后端单元测试覆盖生产冷路由排队后返回 transient failure、已有缓存完整返回，以及分类得到的 `404/410/503`。工具测试覆盖完整 `200`、可重试 `503`、空 SPA `200` 拒绝、显式 `404` 拒绝、报告过期、摘要/覆盖缺失、资源版本漂移、canonical origin 漂移和切流前门禁顺序。发布环境的全量 manifest 证据负责覆盖首页、文章、归档、分类、标签和静态页的真实 URL。
