# Single WASM build receipt

Production fresh 中只有 `frontend-wasm-build` 可以生成或重建 FsusBlog WASM。producer 完成真实 build、完整 source/output hash 和 ownership policy 校验后，在 artifact root 原子写入 `wasm-build-receipt.json`。Browser Contract、visual、production-build-artifacts 与 final-image host 只能消费该 receipt；consumer 校验失败时不得调用 build。

## 身份与失效

Receipt schema 为 `fsusblog.wasm-build-receipt.v1`，active producer ID 为 `frontend-wasm-build`。它绑定：

- repository/worktree、commit、source fingerprint 与 input tree digest；
- Emscripten/emsdk/compiler 及完整 toolchain identity；
- build modes、features 与 production ZK build args；
- output manifest digest、每个 output 的 SHA-256、size 与 immutable file identity；
- `wasm-manifest.aeds` artifact digest table reference；
- ownership policy 文件集合及其 digest；
- producer run ID、run attempt、build count 和 receipt content digest。

任一 source、toolchain、build arg、policy、manifest 或 output 变化都使 exact receipt 失效。缺失 output、普通篡改、symlink、receipt 内容篡改和多个 receipt 候选均 fail closed。Fallback 只返回 `run-canonical-producer`，并明确 `consumerMayRebuild=false`。

## Hash reuse 与跨镜像边界

同一 filesystem 上的 immutable consumer 对 source/output 只比较 producer 记录的 `dev/ino/mode/size/mtime/ctime`，不遍历 source tree、不读取 output bytes，也不重新计算 output hash。producer 将 receipt 中已有的 output digest 投影为 `SHA256SUMS`，该动作同样不读取 output。

Docker COPY 会改变 inode。最终镜像构建依赖 BuildKit 的内容寻址 copy，并只运行一次 `sha256sum -c SHA256SUMS` 验证 transport；随后 `verify-envelope` 校验 receipt content、toolchain/build identity、manifest digest、output set、size 与非 symlink 形态。它不会再运行 `ensure-wasm status` 的 source/output 扫描。

## 本地验收

```bash
node --test \
  tests/tools/wasm-build-receipt.test.mjs \
  tests/tools/wasm-artifact-ownership.test.mjs

node tools/check-wasm-artifact-ownership.mjs
node tools/check-test-matrix.mjs
```

Fixture 覆盖 build count、零 traversal/hash consumer evidence、source/toolchain/arg/policy drift、missing/tampered/symlink output、wrong manifest、tampered/ambiguous receipt、producer-only fallback，以及真实 `sha256sum -c` transport 篡改拒绝。正确性不使用耗时门禁；bytes read、tree traversal 和 hash count 只作为优化证据。
