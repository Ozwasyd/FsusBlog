# Frozen renderer observation evidence

This package publishes the original eight observations and original build identity evidence for source candidate [`d219c182f5087293b15a50b330f54478c0d4695c`](https://github.com/Ozwasyd/FsusBlog/commit/d219c182f5087293b15a50b330f54478c0d4695c). The evidence-only descendant does not change or requalify that source candidate.

[index.json](index.json) lists repository-relative package paths, file sizes, physical SHA-256 values, original observation content digests, build identities and the sealed source identity. [source-identity.json](source-identity.json) records the exact candidate tree and original producer source blobs. [SHA256SUMS](SHA256SUMS) covers every published file except itself.

| Original observation | File SHA-256 |
| --- | --- |
| [auth-session-permission-fact-extractor](observations/auth-session-permission-fact-extractor.json) | `7b6d2f672b091f934edef6320e10e15470b1749bb5e2e6c91218e7f3b55751cd` |
| [code-intent-fact-extractor](observations/code-intent-fact-extractor.json) | `e4741d7a84d937517b7066371338286d6410ee5173e08843b137d5d09d0aac9a` |
| [config-error-security-policy-fact-extractor](observations/config-error-security-policy-fact-extractor.json) | `69c9b524a463d9cf1752bdb1f6b1b9764e3680fc7fae3a659dc40578403137c7` |
| [content-lifecycle-fact-extractor](observations/content-lifecycle-fact-extractor.json) | `81121a7cb4706a504ce1c2441d12f322822b078db5e5ed4b29ed0cd4e97ba97d` |
| [document-lifecycle-fact-extractor](observations/document-lifecycle-fact-extractor.json) | `05c195ac56cbfecd975d538c934fcf053ab8c7537b6b6c59a6ca384083ba8c37` |
| [openapi-aeds-fact-extractor](observations/openapi-aeds-fact-extractor.json) | `516ccc48d255c3cf8b8cb80f9b1034667e01bb4d7286ac869b16f902711276b1` |
| [test-asset-audit-fact-extractor](observations/test-asset-audit-fact-extractor.json) | `8d8f1cfea502336322e3bcaceaa78807681a621538a27d23baa81f184c36f09e` |
| [test-matrix-fact-extractor](observations/test-matrix-fact-extractor.json) | `eed1ec887a65b64f9dd69d5836bd583dd8af561bbf83f2e31e25ae4251054d0b` |

The [minimal build receipt](build/receipt.json) and [run-bound identity receipt](build/identity-receipt.json) are original byte-for-byte copies. The [original extraction result](execution/observations-result.json), [API caller](execution/produce-current-observations.mjs), [command wrapper](execution/run-check.py), recorded commands, timestamps and logs are retained under `execution/`. Absolute paths in original machine records describe the original run; their published copies are located through the relative-path index.

The original generator [check log](execution/final-generator-check.log) records 34 documents and 84 sections. The original [fixed-point log](execution/final-generator-fixedpoint.log) records `written=0`. The eight observations and original SDK 10.0.302 minimal build were successful on the sealed source candidate. No build, extractor, generator or test was rerun to package these files, and no supplier receipt was substituted.

The original [convergence failure](execution/final-root-source-convergence.log) and [structured result](execution/convergence-result.json) remain visible: exit 1 with two independent QPS mappings. This package does not establish full SOURCE, held semantic audit, database, security, product, full-CI or live PR acceptance. Review the recorded generation result against the original clean source candidate; evidence publication is not a new acceptance run.

From this package directory, `sha256sum -c SHA256SUMS` checks copied-file integrity without running repository tests or producers.
