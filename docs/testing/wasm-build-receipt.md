# Single WASM build receipt

In Production Fresh, only `frontend-wasm-build` may generate/rebuild FsusBlog WASM. After a real build and complete source/output-hash and ownership-policy checks, it atomically writes `wasm-build-receipt.json` at the artifact root. Browser Contract, visual, `production-build-artifacts`, and final-image hosts only consume this receipt; a consumer never builds after validation failure. The [WASM contract](../wasm.md) is the runtime authority.

## Identity and invalidation

Receipt schema is `fsusblog.wasm-build-receipt.v1`, active producer ID `frontend-wasm-build`, and binds:

- repository/worktree, commit, source fingerprint, and input-tree digest;
- Emscripten/emsdk/compiler and complete toolchain identity;
- build modes, features, and production ZK build arguments;
- output-manifest digest, every output's SHA-256 and size, and immutable file identity;
- the `wasm-manifest.aeds` artifact-digest-table reference;
- ownership-policy file set and digest;
- producer run ID, run attempt, build count, and receipt-content digest.

Any source, toolchain, build-argument, policy, manifest, or output change invalidates the exact receipt. Missing output, ordinary tamper, symlink, receipt tamper, or multiple receipt candidates fail closed. Fallback returns only `run-canonical-producer` and states `consumerMayRebuild=false`.

## Hash reuse and cross-image boundary

On one filesystem, an immutable consumer compares producer-recorded `dev/ino/mode/size/mtime/ctime` for source/output only: it does not traverse the source tree, read output bytes, or recompute output hashes. The producer projects existing receipt digests to `SHA256SUMS`, also without reading outputs.

Docker COPY changes inodes. The final image uses BuildKit content-addressed copy and runs `sha256sum -c SHA256SUMS` exactly once for transport, then `verify-envelope` checks receipt content, toolchain/build identity, manifest digest, output set, size, and non-symlink form. It does not rerun `ensure-wasm status` source/output scanning.

## Local acceptance

```bash
node --test \
  tests/tools/wasm-build-receipt.test.mjs \
  tests/tools/wasm-artifact-ownership.test.mjs

node tools/check-wasm-artifact-ownership.mjs
node tools/check-test-matrix.mjs
```

Fixtures cover build count, zero-traversal/hash-consumer evidence, source/toolchain/argument/policy drift, missing/tampered/symlink output, wrong manifest, tampered/ambiguous receipt, producer-only fallback, and real `sha256sum -c` transport-tamper rejection. Correctness has no duration gate; bytes read, tree traversal, and hash count are optimization evidence only.
