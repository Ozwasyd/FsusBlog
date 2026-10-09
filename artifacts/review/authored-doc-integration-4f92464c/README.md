# Current document integration evidence

Original evidence for source candidate [`4f92464c6a0508df32a5e911cdf31735b16417dc`](https://github.com/Ozwasyd/FsusBlog/commit/4f92464c6a0508df32a5e911cdf31735b16417dc). This evidence-only descendant publishes existing records; it does not change or requalify the source candidate.

[index.json](index.json) maps relative file paths to sizes and physical SHA-256 values and records the sealed source/build identities. [source-identity.json](source-identity.json) records exact source blobs. [SHA256SUMS](SHA256SUMS) covers all published files except itself.

| Original current observation | File SHA-256 |
| --- | --- |
| [auth-session-permission-fact-extractor](observations/auth-session-permission-fact-extractor.json) | `108e1f363935530ebcd840235eda6bc201b84e0a0dd0a145e644d31a3e8dde9c` |
| [code-intent-fact-extractor](observations/code-intent-fact-extractor.json) | `0dfa3f97a60619ff47de5e5df712ba9514d0f3a724fe59dbb3923956cefa4c0e` |
| [config-error-security-policy-fact-extractor](observations/config-error-security-policy-fact-extractor.json) | `f5bd6709df71e32bfc3f15d82564a96a86b8b698729326209675ef52424dd857` |
| [content-lifecycle-fact-extractor](observations/content-lifecycle-fact-extractor.json) | `83a60b330b45a17004d7eecadc45e0f4ac956afd8429f21dcbf2bd376d0ac32a` |
| [document-lifecycle-fact-extractor](observations/document-lifecycle-fact-extractor.json) | `1db70be511cbb98dc3e25e489f1a00626b0a5c0cba3c7291b63f7e2845ff677b` |
| [openapi-aeds-fact-extractor](observations/openapi-aeds-fact-extractor.json) | `29935f8b8ddbb1959d17df6403549de34045a1f7ad3e6b5b13ad5440cc8aae6d` |
| [test-asset-audit-fact-extractor](observations/test-asset-audit-fact-extractor.json) | `c5e97520a04ff21fd2f5cd01b3b3be57ea0243eab7dda22c96ac43276a5ce848` |
| [test-matrix-fact-extractor](observations/test-matrix-fact-extractor.json) | `ffc9783178508668452f9d4b94dc37dbaac4dfa88939764aa3420110e37eedcf` |

The [original minimal build receipt](build/receipt.json), [run-bound identity receipt](build/identity-receipt.json), eight observations and original execution files are byte-preserved copies. Absolute paths in machine records describe the original run; published copies use the relative paths in the index. The SDK 10.0.302 original minimal build and eight uncached extractors succeeded on this exact candidate. No build, extractor, producer or test was rerun for packaging; prior-candidate and supplier receipts are not substituted.

The [original generator check](execution/final-generator-check.log) records 34 documents / 84 sections. The [original fixed point](execution/final-generator-fixedpoint.log) records `written=0`. The [six-document original native check](execution/final-six-document-native.log) reports zero violations and no baseline exemptions while preserving nine existing registered compatibility aliases; raw Markdownlint exit remains 1 for those registered aliases. This is the current ordinary native policy result, not a claim that the raw tool or repository-wide SOURCE stage is green.

The [source composition proof](execution/doc-composition-proof.json) binds the exact two document increments and thirteen unchanged generated regions. The [whole-file binding refresh](execution/full-file-binding-refresh.json) records all thirteen physical output hashes and the six complete document hash changes. [Original renderer controls](execution/final-allowlisted-renderer-controls.log), [complete two-file renderer style](execution/final-renderer-full-style.log) and [offline proposed metadata](execution/proposed-pr-contract-results.json) retain their original current results. Offline metadata is not a live PR event or independent final acceptance.

The [preserved QPS failure](historical/d219-convergence.log) and [structured result](historical/d219-convergence-result.json) belong only to frozen source `d219c182f5087293b15a50b330f54478c0d4695c`. They are historical failures and are not relabeled as current-candidate convergence results. Implementation convergence, full SOURCE, held semantic audits, database/security/product/full-CI and live PR acceptance are not established by this package. The earlier accidental read-only CLI glob scan remains in its original source-worker scope; the current original native checker uses its scoped `--no-globs` invocation.

From this directory, `sha256sum -c SHA256SUMS` checks copied-file integrity without running repository tests or producers.
