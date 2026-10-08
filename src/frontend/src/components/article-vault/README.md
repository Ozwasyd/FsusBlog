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
Plan review and receipt-driven execution/recovery must consume the actual
[#2120](https://github.com/Ozwasyd/FsusBlog/issues/2120) and
[#2121](https://github.com/Ozwasyd/FsusBlog/issues/2121) capabilities.
The shared Article Write route and navigation remain with their integration
owner. Component fixtures prove presentation behavior; they do not establish
current authorized transport or full terminal acceptance under
[#2123](https://github.com/Ozwasyd/FsusBlog/issues/2123).
