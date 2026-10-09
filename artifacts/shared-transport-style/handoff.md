# Shared binary transport ordinary source handoff

Related to [#3735](https://github.com/Ozwasyd/FsusBlog/issues/3735), [#2325](https://github.com/Ozwasyd/FsusBlog/issues/2325) and [#1889](https://github.com/Ozwasyd/FsusBlog/issues/1889). Source commit **dea86a509b185cdb75bdc2146f1fc1b8ee71e075** on `codex/shared-transport-style-20261009`; verified master base **537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea**. This is a separate current-base transport delivery; frozen registration, Canvas and metadata-consumer branches are unchanged.

The sole product file is `src/frontend/src/api/binaryApiClient.ts`. Against supplied consumer **a0d58a2f3b5121dd34e6e9a1eabcc836e15b268f**, its diff is exactly the shared rejection callback's `Error` parameter annotation and explicit consumption of the destructured proof option. The current-master delivery also carries that consumer's canonical `location.href` line. Consumer blob **f40d2e6cd1e240217269d7628edf88bbf1451ff2** becomes **f75932afdcedce739e1b7e99bba684d7be72d1c5**. No consumer branch is imported.

The annotation expresses the actual fetch/Web API/Error producer contract; it adds no runtime narrowing, cast, error wrapper or normalization. Every original rejection value is passed directly after the same settled/cleanup sequence. Regression controls also prove unchanged exceptional non-Error identity, rather than assuming TypeScript makes rejection values closed. `void _riskChallengeProof` consumes the intentional stripping binding without another getter read or changing the rest object, header/auth decisions, cancellation or proof settlement.

At exact source **dea86a509**, original `binaryApiClient.test.ts` remains byte-exact master and executes its original **24** controls. The supplemental owner executes **6** rejection/cleanup/cancellation/option tests. All **30 pass, zero fail/skip** on actual Node **24.19.0** and **24.16.0**, with original Vitest **4.1.11**, happy-dom **20.9.0**, `vitest.config.ts` and setup hooks. Actual local FsusUI source remains frozen **f2b3bb89ffe5f749da26c388f058efdbb6aee864**; this is no published/local full-type qualification.

The unchanged original changed-style entrypoint passes on Node **24.16.0**, ESLint **10.8.0** and typescript-eslint **8.65.0**, **files1 / violations0**, for the complete touched product file. Test TypeScript is outside the configured product style source sets. No policy, lint configuration or baseline is edited. The independent style toolchain was installed with its existing lockfile using `npm ci --ignore-scripts --prefix tools/frontend/style-toolchain --no-audit` and a task-owned npm cache. Official Node24.16.0 archive SHA-256 is `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`, compared with the official published checksums.

[Run evidence](run-evidence.json) binds the source blobs, exact tools, controls, raw logs and original JSON/XML reports. Initial missing Vue-plugin resolution, style-directory reads, default-cache installation failure, missing partial-toolchain executables and missing happy-dom setup are preserved as failed attempts. The actual original Vite extension warning is visible and unsuppressed. Subsequent documentation/evidence commits do not move these source receipts to a whole-head qualification.

Next ordinary commands after the existing documented tooling and local-source setup:

```bash
node tools/frontend/check-frontend-style.mjs --mode changed --base 537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea --file src/frontend/src/api/binaryApiClient.ts
npm --prefix src/frontend exec -- vitest run --config vitest.config.ts ../../tests/frontend/unit/api/binaryApiClient.test.ts ../../tests/frontend/unit/api/binaryApiClientTransportStyle.test.ts
```

The second command must resolve the original configuration from `src/frontend`, using the existing repository-local test invocation; in this run the explicit Vitest executable was invoked with that working directory. Consumer owners can apply source commit dea86a509, preserving their existing canonical URL line, and reexecute original selected checks on their resulting exact source. If incorporation conflicts, report affected paths and leave cross-chain resolution to the parent phase.

Full frontend types, application build, required whole CI, authenticated HTTP/session/PoW/provider/Postgres, rendered UX and independent acceptance are **UNRUN / OPEN**. Held integrity/receipt/cohort/template/workspace/graph/replacement audits were not executed. There is no route activation, production migration, deployment, merge, auto-merge, issue closure or acceptance of the 70-item queue. Rollback this transport increment only on its owner branch before coordinated integration; do not replace later consumer changes with an old whole-file snapshot.
