# Vault conflict evidence presentation

## Exact stored review increment

`VaultStoredConflictReview.vue` composes the actual conflict and proposal leaves
from the new server `ArticleVaultConflictReviewReader.ReadAsync`. That reader
uses canonical `IArticleVaultResolutionProposalStore.ReadExactAsync` and
`ArticleVaultRecoveryCheckpointReader.ReadAsync` at `8b98366438ed76de4b6b57e682dba3939f89eb87`.
The accepted-source/preflight bytes on this baseline match
`9cd6ae50b233eee35f291c9690d316bbfee37941`; no alternate source reader is added.
The server checks the authenticated principal against the original sealed bundle,
the trusted site/Vault/device/document binding, and existing live-session permission
snapshots before and after reading. Its optional `CurrentEvidence` is present only
when the actual canonical `VerifyCurrent` result passes. Historical stale proposals
remain reviewable with their rejected validation result and no current decisions.
Private accepted-source packages are not included.

These are in-process reader and read-only display subsets, not a new public JSON
API, authentication grant, parser or generated wire contract. The integration host
must supply actual current inputs, bind its configured permission site to the
trusted Vault site, and expose this reader through the canonical AEDS boundary.
Its generated frontend binding/authorized transport is still required.

The host wraps each actual response with the originating display context,
reference and `requestIdentity`. Context includes the current actor, session epoch,
site, Vault, device and document. Every read, including a refresh of the same exact
reference, needs a distinct host-issued request identity. Changing these props or
setting `loading`/a current read refusal hides old results immediately. The host
must discard stale async responses and invalidate results when current facts or
permissions change; correlation is not machine verification. Never log or render
the session correlation epoch as a credential.

`request-read` and `request-return` carry the current context and explicit proposal/
operation-checkpoint reference. Native fragment links provide actual navigation
between the mounted conflict and review sections; the host owns workspace return,
router registration and focus. No route name is invented. `request-action` remains
the exact per-item intent from `VaultConflictList`, not a writer command.

Canonical operation checkpoints (`operation-checkpoint.v1`, sequence starting at
zero) are displayed separately from resolution recovery journals. They are never
relabelled as the latter. Historical `synced` records are not current native/base
qualification. Canonical missing-capability reasons stay visible. Actual producer
source `5928e10…`/`c962b70a…` exposes status and agent stop/unlink, not resolution
cancel/recover. Those product controls remain disabled; no substitute command,
receipt, journal store or permission flag is implemented. Root enumeration/private
temp preparation at `5e7fd98…` does not supply final replace/remove or base commit.

`VaultConflictList.vue` is a read-only product composition. The host supplies
authorized, codec-decoded, current-bound `ArticleVaultConflictEvidence` values
and the actual shared `article-vault-conflict-evidence.schema.json` document.
`ConflictEvidencePresentation` and `ConflictDisplaySchema` describe only the
fields read by this component; they are not new wire contracts or validators.

The component preserves article input order and canonical item order. It renders
ten article entries per page, at most the schema's twelve item types, and twenty
source ranges or metadata fields per diagnostic disclosure. Source values,
private metadata, tokens, transport, persistence and telemetry are outside this
component. The host must keep observation/context loading bounded and authorized.

`request-action` emits an intent with the exact evidence digest, operation,
portable article identity, item type and supplied closed action. No action is
selected by default. The host forwards the intent to the canonical resolution
plan owner, which must revalidate current facts and produce a new immutable
plan. An intent is neither a closed decision nor permission to execute. The
component does not generate a plan, confirm execution, save a diff, change
machine status, recover an operation or qualify evidence.

Product integration belongs to [#2122](https://github.com/Ozwasyd/FsusBlog/issues/2122).
`VaultResolutionStatus.vue` consumes read-only subsets of the actual `bb49a4c`
resolution-plan and recovery-journal contracts. It shows immutable proposal
references, expected effects, atomic groups/dependencies and an explicitly
requested checkpoint. It never selects the newest checkpoint. A `Complete`
descriptor is not physical backup, materialization, cleanup or execution proof.
The only event, `request-current-check`, names the exact operation, plan digest
and checkpoint identity/digest for the host's canonical verifier.

Each check prop wraps the unchanged canonical `ArticleVaultValidationResult`
in host correlation metadata (`requested` plus `result`). This wrapper is a
display envelope, not a new wire validator or admission contract. Checks for
another plan are hidden as stale; history/recovery checks also require the exact
requested checkpoint. The host must clear results when current facts change,
reject stale async responses, and bind the returned canonical result to the
request it actually verified. This component cannot verify that transport.
Missing execution/materialization admission remains visible as the canonical
refusal reason. It offers no execution, confirmation or recovery mutation.

Plan review and receipt-driven execution/recovery must consume the actual
[#2120](https://github.com/Ozwasyd/FsusBlog/issues/2120) and
[#2121](https://github.com/Ozwasyd/FsusBlog/issues/2121) capabilities.
The shared Article Write route and navigation remain with their integration
owner. Component fixtures prove presentation behavior; they do not establish
current authorized transport or full terminal acceptance under
[#2123](https://github.com/Ozwasyd/FsusBlog/issues/2123).
