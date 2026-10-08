Title: fix(test): verify correctness inventory against the canonical roster

Base: 5798707d359ce5ee57752aa868d0ccbf3f889494
Candidate: 40d9774b3bab7e21b845984eff7e963d5c832c52
Branch: codex/chain-3521-correctness-catalog-verified

The current canonical matrix declares 226 correctness producers. The generated catalog retained all 226 rows but had stale matrix/document digests, while the migration verifier independently rejected any count other than 225. Regenerate the catalog through its unchanged canonical producer and let its unchanged complete-roster validator remain the authority. Preserve all original producer records, policies, assertion coverage and crossed-owner refusals; keep the historical test case identity. Bind the changed migration source through the original execution fixture producer and ordinary source/output metadata.

Current exact ordinary seven controls and catalog --check pass. Complete direct-base commit range passes. Exact original producer fixed point and SOURCE receipts are provided in the evidence handoff when finished. Product/runtime/cohort/native qualification remains unavailable.

Current generated-catalog PR admission is a separate remaining gate: generator and matrix sources are unchanged from this base, so the catalog cannot claim ordinary source change provenance from the migration CLI. The existing retrospective digest-repair v2 authority is frozen to its historical tuple. No forged output binding, source nudge, policy exemption, matrix ownership change, historical retirement or unsafe3926 mutation was introduced. Current formal catalog-only admission requires the canonical owner and coordinator reviewed current-epoch authority or legitimate current-matrix source composition.

Related to #3521. Content-write queue remains held; this is a review description, not a created PR.
