# Article rights mutation state machine

## Purpose

Article writes distinguish an omitted rights field from an explicit replacement or reset. An omitted field must never
silently overwrite the effective article policy.

## Mutation modes

| Mode | Request shape | Create | Update / rollback | Policy row | Revision snapshot |
| --- | --- | --- | --- | --- | --- |
| `preserve` | rights omitted | bind repository defaults | retain the current effective policy | unchanged when already equal | create only when a new content revision needs a binding |
| `replace` | complete rights payload | bind supplied policy | replace with supplied policy | update only when effective fields differ | bind the new revision |
| `reset` | explicit reset flag and no rights payload | bind repository defaults | replace with repository defaults | update only when effective fields differ | bind the new revision |

`replace` without a payload fails with `article_rights_payload_required`. `reset` plus a replacement payload fails with
`article_rights_reset_payload_conflict`. Unknown mutation values fail with `article_rights_mutation_invalid`.

## Path consistency

- Normal create without rights uses default policy values and creates its first immutable snapshot.
- Normal update and revision rollback explicitly use `preserve` when rights are absent.
- Markdown import explicitly uses create-side `preserve`; therefore a newly imported article receives defaults rather
  than inheriting unrelated state.
- Scheduled publishing does not re-resolve policy. It publishes the rights snapshot already bound to the claimed
  revision.
- Every successful article create/update response reports the article ID, bound rights snapshot ID, and rights revision
  number in the extended article mutation payload.

## Binary compatibility

- V4 carries `rightsMutation` explicitly.
- V3 always carried a complete rights section and is interpreted as `replace`.
- Payloads from before the rights section was introduced are interpreted as `preserve`.
- The response keeps frame type `MutationId(241)`: generic mutations remain the original 8-byte ID payload, while
  article create/update/rollback use the 48-byte `ArticleMutationResultPod`.

## Risk and rollback

The main risk is a client emitting `replace` with values it did not load from the current article. Clients should omit
rights for metadata-only saves and use reset only after an explicit author action. During rollout, an unhealthy candidate
can be removed from the active slot without restarting the serving slot; clients on either side of the deployment remain
compatible through V3 and pre-rights decoding. Rollback must not restore the old behavior that normalizes omission into a
replacement.
