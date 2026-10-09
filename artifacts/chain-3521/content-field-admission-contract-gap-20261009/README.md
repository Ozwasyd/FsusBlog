# Content field generated-only admission gap

Related to #3521 and #3590. This is an evidence-only investigation, not a producer admission or generated-output binding correction. It preserves the checker, registry, schemas, consumer branches and generated products unchanged.

The exact consumer candidate is `aa5b5bb4e07fd51446646b829b17266316b9a918`, after `95558d6d831a895cd020c311507ac7f48e860824`. Current master used for this inspection is `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`; their actual merge base is `85aa75af8949401ef9997c5042d22b1071414e0a`. All 16 consumer increment paths are recorded. No sibling source was merged or cherry-picked.

The real producer is `node tools/testing/content-shape-catalog.mjs --write-field-projection` with Git blob `7169ce0780300e0cb1163d38a442376aeb05dd76`. Its actual output is `config/testing/content-field-contracts.generated.json`, Git blob `9a78417c65e54fdfea0b13931e0c2094b303b4b2`, raw SHA-256 `1da6bef00ab75ab9acc7c413ec78ee7797d90969efe0324e097a3488610d4fb3`.

Read-only exact Git/JSON accounting proves all four field records are preserved, only the article-validator semantic binding and total digest changed, and three other bindings are preserved. Four production sources, nine explicitly identified build inputs and the real producer are unchanged in the consumer increment and current master. These 14 paths are the minimum explicit inputs, not a claimed complete Roslyn/MSBuild compilation closure. The producer also builds the production backend with its real project/reference/source graph. The output binding hashes are semantic contract hashes, not raw Git source hashes.

The current ordinary binding artifact binds four other outputs and omits this field projection. Adding this output to unrelated correctness/fixture sources would not bind the actual producer. Adding real unchanged inputs would be refused by the existing all-sources-changed ordinary binding rule.

No existing generated-only form truthfully admits the tuple:

- Ordinary binding v1 requires all actual source/output paths to change in the PR.
- Post-merge repair v1 accepts one source path and generator path, and a single-parent source event must change only that source. The current validator owner `a80834703b9b314bcd41c188c5c5d1a952b281e4` has one parent and 86 changed paths. The four-source compiled input/producer identity closure has no additional accepted manifest fields. A real named two-parent outer merge is also required.
- Digest repair v2 hardcodes correctness-attempt-producers, `--write`, its inventory schema and `sourceDigests`/`entries` output shape with raw Git-byte input hashes. The content-field command/schema/semantic hashes cannot borrow that qualification tuple.
- DAG repair v2 currently registers the evidence-location scanner graph; its schema fixes `sourceProjection.projectionId` to `fsusblog.evidence-location-scan.v1`. Relabeling compiled content-field extraction as that scanner is false.
- Sealed-history repair v3 hardcodes the backend-evidence-path-authority command, six-file closure, schema and output.

`contract-gap-handoff.json` records exact missing contract decisions and source line references. `governing-source-excerpts.json` binds each quoted governing source to its revision, Git blob, SHA-256 and lines. A separately authorized versioned or producer-specific contract decision is needed; no such extension is implemented here and no acceptance or promotion is claimed.

Executed here: exact candidate identity/input/output accounting, original unchanged producer syntax check and original registry syntax check; all exited 0. The five consumer controls and SDK/runtime execution were reported by the coordinating parent and were not rerun or converted into this review's runtime evidence. The exact portable Group3 evidence commit/body was requested but not supplied at recording time, so this review does not claim independently reproduced public PR metadata diagnostics. Static source binds the reported missing-output diagnostic to the original checker.

The original producer was not executed or resealed here. Full standard SOURCE, historical replay/mutation callbacks, receipt/cohort/Gitref/race and held audits were NOT_RUN. No policy/checker/schema/allowlist, output or runtime source changed. GitHub content remains with the coordinating root.

Command records include exact execution source, UTC run identity, argv, PID, exit status and raw-log byte count/SHA-256; gzip archives preserve the original bytes. Qualification is false. The file index binds every other bundle file by bytes, SHA-256 and Git blob.
