# Security domain ownership

`security/` stores reviewable, non-executable security declarations, not runtime output. Issue #1170 divides the domain into five non-interchangeable ownership boundaries:

| Boundary | Canonical path | Authority |
| --- | --- | --- |
| Control and test matrices | `security/matrices/` | `security/matrices/catalog.json` + `check-security-matrices.mjs` |
| Analyzer and warning policies | `security/policies/` | Each policy carries schema, version, owner, severity, rationale, and path scope |
| ZK semantic contracts | `security/zk/contracts/` | circuit, tamper, and feasibility contracts |
| ZK provenance | `security/zk/provenance/` | trusted setup, local review, and artifact ownership |
| Static evidence contracts | `security/evidence-contracts/` | Only `contract` / `implementation-attestation`; never a fresh-run claim |

`security/catalog/security-domain.json` is the master catalog of each boundary's owner, checker, exact static file set, and runtime selection. `tools/security/check-security-domain-layout.mjs` aggregates layout, schema, path, hash, and classification errors. Root-level stray files, symlinks, executables, unregistered directories, old flat paths, provenance used as a circuit contract, and static contracts posing as fresh/release evidence all fail closed.

## Runtime and hash binding

Runtime `CircuitManifestPath` must target `security/zk/contracts/`; release/debug images package that directory unchanged at `/app/security/zk/contracts/`. Repository trusted setup must target `security/zk/provenance/`; production supplies the real setup/key/review from a read-only `/app/config/zk/` mount, which is not a repository-ownership exception. The v2 trusted-setup manifest continues to bind the circuit-manifest SHA-256, and local review binds circuit, setup, artifact ownership, implementation, and test sources file by file. Moving or changing any byte requires review and hash updates; old paths are never silently accepted.

## Risk and rollback

This migration does not change circuit id, public-input layout, proof system, ceremony state, API, authentication, notification stream, or AEDS binary semantics. Startup validation and the repository checker block the main risks: deployment still points to an old flat path, or a moved file's hash was not rebound. The no-restart business degradation remains reloading `AnonymousIdentity:ZkProd:Enabled=false`, keeping anonymous ZK comments fail closed. A repository rollback must restore the catalog, paths, configuration, and hash bindings from the same commit; never restore only one manifest.

## Verification

```sh
node tools/security/check-security-domain-layout.mjs
node tools/security/check-security-matrices.mjs
node tools/security/comment-privacy-build-contract.mjs
node tools/security/check-zk-comment-v5-manifests.mjs
node tools/security/check-zap-warn-policy.mjs
node --test tests/tools/security-domain-layout.test.mjs
```

The scenario boundary is unchanged: anonymous and ordinary login requests use only enabled, fully bound ZK configuration; admin gains no privilege; notification stream behavior is unchanged; and the binary API accepts only AEDS v2.
