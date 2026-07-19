# Comment Creation Moderation State Machine

Issue #1189 removes the window in which a newly inserted comment was publicly `Approved` before model review.

## Initial state

The server resolves the state before the insert transaction:

| Condition, in priority order | Initial state | Reason code |
|---|---|---|
| Region `HideUntilReviewed` | `Hidden` | `hidden_region_review` |
| Region requires manual review | `Pending` | `pending_region_review` |
| Anonymous credential requires moderation | `Pending` | `pending_anonymous_policy` |
| Anti-spam model is enabled | `Pending` | `pending_model_review` or `pending_model_provider_unavailable` |
| Deterministic low risk and no model required | `Approved` | `approved_deterministic_low_risk` |

`comment`, region compliance and anonymous nullifier consumption commit atomically. Public queries continue to filter on `Approved`; a `Pending`, `Hidden` or `Rejected` row is never placed in a public frame or notification.

## Model transitions

- `score-only`: stores the signal and keeps `Pending`.
- `auto-low-risk-approve`: clean signals at or above the configured threshold may move `Pending -> Approved`.
- `auto-hide-high-risk`: risk hits may move `Pending -> Hidden`.
- `strict-auto-moderate`: applies both clean approval and risk hiding.
- unavailable, timeout, contract-invalid or missing provider remains `Pending` by default. `FailOpen=true` is explicit and still cannot override region or anonymous-review requirements.

Every automatic transition uses the previous status plus PostgreSQL `xmin` as its compare-and-swap guard. A concurrent admin decision wins; the model retry does not overwrite it.

## Side effects and audit

Only a committed transition into `Approved` invalidates public comment cursors and publishes `CommentAdded`. Only a transition out of `Approved` publishes `CommentRemoved`. User-scoped `/comment/me` invalidation remains independent so authors can observe pending and hidden states.

Migration `20260719-post-comment-moderation-event` installs an append-only `comment_moderation_event` table and database trigger. Inserts record the initial state; every later status change records previous/next status, reason, source and admin principal. UPDATE and DELETE against the event table are rejected.

## Response contract and rollback

Both comment creation endpoints return `CommentCreateResult` frame `205`, including the final synchronous `moderationStatus`, `visibilityState` and `isPubliclyVisible`.

No restart is required to degrade model automation: switch `Mode` to `score-only` or disable the model through the existing moderation runtime configuration. This keeps model-required submissions in `Pending`. Enabling `FailOpen` is an explicit availability trade-off and must not be used to override region or anonymous policy.
