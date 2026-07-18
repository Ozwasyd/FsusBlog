# CSP nonce UTF-8 segment templates

## 决策

Public AOT 与 PublicHotRead 的 HTML artifact 在生成或反序列化时调用 `CspNonceUtf8Template`。编译器一次性扫描 document、验证 HTML/nonce 边界、注入 compiler-owned slots，并保存单一 UTF-8 template buffer 与 slot offsets。请求只把同一个 16-byte CSPRNG 生成的 base64url nonce 编码一次，按 offsets 写入 `HttpResponse.BodyWriter`，然后等待一次 `FlushAsync`；不产生完整 rendered `string` 或 `byte[]`。

nonce 改变每次响应的实体，因此选择以下缓存/压缩模型：

- `Cache-Control: private,no-store`；不发 ETag，不处理为 304；
- PublicHotRead L0 使用 identity streaming，`identity;q=0` 返回 406；
- nonce artifact 不生成或驻留不可复用的静态 br/gzip variants；
- 静态无 nonce artifact 继续使用发布期 br/gzip 与 variant ETag；
- 不在请求内使用 `CompressionLevel.SmallestSize`，也不先合成整页再压缩。

该选择优先消除每请求两次整页复制、LOH 与压缩 CPU。真实 page bytes、identity/br/gzip 大小和 before/after CPU/allocation 由 `CspNonceHtmlHotPathBenchmarks` 与 release evidence 记录；若未来引入流式压缩，必须保持 segment writer、取消/backpressure 和 no-store 语义，并独立补齐 p99.9 证据。

2026-07-14 本机基线（Intel Xeon Gold 6230、8 logical CPUs、.NET 10.0.8、164,814-byte nonce response）：

| 路径 | BDN mean | allocated/op | profile p99.9 | estimated copied bytes | LOH/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| 旧整页 decode/replace/encode | 569.206 µs | 781,645 B | 10.618 ms | 967,224 B | 1 array + 2 strings |
| UTF-8 segment writer | 7.044 µs | 0 B | 39.491 µs | 164,814 B | 0 |

同一 profile 的 `CompressionLevel.Fastest` 每请求压缩证据：identity 164,814 B；gzip 5,673 B、mean 548.329 µs、11,984 B/op；Brotli 3,683 B、mean 205.387 µs、15,001 B/op。L0 位于 response-compression middleware 之前，因此本次选择确定性 identity streaming，避免重新引入约 0.21–0.55 ms 的请求 CPU 与分配；带宽优先部署可在后续实现真正的分段流式压缩，但不能退回整页 buffer。完整机器可读证据由 `--csp-nonce-profile` 和 BenchmarkDotNet JSON 生成到 `.tmp/issue-1060/`，不提交临时产物。

## CSP hash 可行性

编译器对无 `src` 的完全静态 inline `script`/`style` 自动生成 SHA-256 CSP source，清单与 artifact identity 及 template digest 同生命周期，不允许手工维护。当前仍使用 nonce：hydration/bootstrap 与运行时插入内容需要统一 nonce，hash-only 切换尚未通过完整跨浏览器安全 smoke。只有清单生成、artifact digest 一致性、安全负向用例及真实浏览器 enforcement 全部通过后，才能对明确静态节点逐项切换。

## 生命周期与预算

`PublicAotHtmlArtifact`/`PublicHtmlArtifact` 直接持有模板，`PublicHotReadSnapshot` publication 原子替换整个可见 HTML map，不使用 `ConditionalWeakTable` 或字符串对象身份。旧请求可安全读旧 snapshot；最后一个引用消失后旧模板可回收。`ResidentBytes` 包含原始/压缩 artifact、模板 buffer、slot offsets 和 hash feasibility list；`MaxResidentBytes=0` 按运行时 managed-memory limit 自动派生，显式正值可覆盖，超预算 publication fail closed 并保留旧 snapshot。

## 风险与无需重启回退

- 解析器误拒绝：保持当前 snapshot，失效失败 artifact 后重新生成；不得发送缺 nonce HTML。
- L0 行为异常：通过 reload-capable 配置设置 `PublicHotRead:Enabled=false`，请求回到常规 Public AOT/SPA 链；PoW、风险门控和 CSP 不关闭。
- AOT artifact 异常：删除对应 document cache entry、触发 backfill；content-hash hydration sidecar 可保留。
- 不允许的回退：固定 nonce、跨请求缓存 rendered HTML、`unsafe-inline`、复用静态 compressed bytes/strong ETag。

## 验证

定向覆盖包括 multi-slot、nonce uniqueness、CJK/emoji、malformed/attacker input、HEAD、cancellation、真实 Pipe backpressure、ETag/no-store、br/gzip/identity negotiation、snapshot replacement、resident budget、静态 hash 绑定和 browser CSP enforcement。执行入口：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Debug --filter 'FullyQualifiedName~CspNonceUtf8TemplateTests|FullyQualifiedName~WebApplicationCompositionExtensionsTests|FullyQualifiedName~PublicHotReadFastPathTests'
tools/test/lanes/backend-benchmark-regression.sh
pnpm --dir src/frontend exec playwright test tests/frontend/e2e/acceptance/public-routes.spec.ts --grep 'public CSP nonce enforcement'
```
