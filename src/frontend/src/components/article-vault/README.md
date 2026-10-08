# Vault conflict evidence presentation

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
