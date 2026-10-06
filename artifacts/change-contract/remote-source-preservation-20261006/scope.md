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

## Maintained read-only source entrypoint

The original two source commits through `90e2ae9b1d4701815d4ec91baa5948a009ed27c7`
remain in ordinary history. The original executable has moved to
`tools/operations/verify-historical-preservation.py`, the existing operational-tool
source owner. This directory retains handwritten historical data and its local
format schema; neither is generated output or a current policy. The preceding
historical scope describes the original observation and original CLI.

The maintained CLI requires an exact current local HEAD and an explicit committed
manifest Git commit revision/path. That explicit historical object grants no
current authority, whether or not it is an ancestor of local HEAD. It compares the complete supplied manifest bytes with that
regular Git blob, including the entire ref roster; a shortened/re-signed shadow
manifest cannot reuse the original source binding. Recorded historical bindings
are explicit caller inputs and do not prove current remote presence. Some original
refs have since been deleted; successful historical verification does not restore,
authorize deletion of, or grant authority over any ref. A live read-only origin/PR
observation requires explicit `--live-bindings` and refuses moved/missing bindings.
GitHub PR number, head and merge are bound independently. Source-at-merge means
whole regular mode/blob equality at that PR-bound merge, with merge ancestry to
the audited master; it does not assert source commit ancestry through a squash or
cherry-pick. Independent semantic review, current source integration, CI, issue
acceptance and cleanup authorization are always outside this verifier.

The tool disables replacement objects, optional Git locks, external diff/textconv,
and status fsmonitor hooks. It verifies the current local HEAD, index bytes,
local refs and tracked status/diff before and after reading the historical objects.
It holds regular bounded input file descriptors, checks their physical epochs,
and checks the same input bytes again before emitting a successful report. It
writes only JSON stdout, creates no object/index/ref/checkout, and never fetches,
pushes, deletes refs, retries a mutation, installs dependencies or executes SDK,
SSH, VM, native acceptance, historical CLI payloads or diff witnesses.

For the original fourteen-row data, use the exact source revision/path shown in
[the current operations entrypoint](../../../docs/operations.md#historical-source-preservation-verification).
The original eleven controls remain available through `--self-test`; task-owned
Git fixtures additionally cover current HEAD drift, complete roster/source-at-merge
refusal, committed-input substitution, symlink input and actual index mutation.
