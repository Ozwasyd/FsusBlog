# Historical remote source preservation

This manual historical proof binds fourteen exact remote refs and 86 valuable
owned paths to existing merged PRs and audited master
`726ffb95a19de85a06d69fe05a537e4d3294a971`. Child issue
[#3729](https://github.com/Ozwasyd/FsusBlog/issues/3729) covers this metadata WIP.
The product source already exists on master; this artifact replaces no missing
implementation and introduces no current normative authority.

`historical-preservation.json` records every source/head/merge/current mode and
blob, full owned increment and current diff witnesses, and reviewed owner
mappings. Its format schema is local historical documentation. Neither file is
generated current configuration or a repository policy. All original acceptance
and parent issues remain independently governed. PR #3484's missing historical
checks and legacy metadata never establish current standard green.

`verify_historical_preservation.py` is a real read-only historical verifier. It
reads Git objects with replacement refs disabled and fresh remote/GitHub PR
bindings. It checks merge ancestry, the complete owned path set, exact
source-at-merge, fixed WIP metadata identities, and full mode/blob/diff witnesses.
It creates no checkout, downloads no dependency, and performs no outward write.
Its JSON stdout is transient evidence and is not a checked-in generated output.
The eleven negative controls are available through `--self-test`.

The 28 current-owner mismatch mappings require independent candidate-bound human
review. Provenance and byte/diff verification do not automate semantic equivalence
or qualify runtime, visual, native engine, full CI or original issue acceptance.
The existing trusted change-contract and required standard gates still govern
this metadata candidate. The verifier always reports `deleteAuthorized: false`.

Root will publish the full original-issue WIP texts and retain their returned
comment links as distinct task evidence. This frozen WIP commit does not pretend
that pending comments have been published. Before any separately authorized
cleanup, require the approved metadata merge and its actual gates, complete WIP
commit/issue provenance, a fresh current-master preservation review and exact
remote-head CAS. A newly changed valuable owner or remote head requires re-audit.
The active #3524 Native family and all unproven remote refs are excluded.
