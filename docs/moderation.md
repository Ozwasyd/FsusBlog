# Moderation Runtime

FsusBlog owns the moderation model runtime boundary. `FsusAntiSpamModel` is loaded as a first-party portable runtime data package by the built-in loader; third parties may provide the same signed portable format, but FsusBlog does not execute third-party model code.

## Anti-Spam Model

The anti-spam model layer is optional and disabled by default:

```json
{
  "Moderation": {
    "AntiSpamModel": {
      "Enabled": false,
      "RuntimePath": "/opt/fsusblog/models/fsus-antispammodel/stable",
      "RuntimeChannel": "stable",
      "RequireSignature": true,
      "TrustedSigningKey": "replace-with-runtime-signing-key",
      "Mode": "score-only",
      "AutoApproveConfidenceThreshold": 0.95,
      "AutoHideConfidenceThreshold": 0.9,
      "FailOpen": false,
      "TimeoutMs": 800,
      "MaxContentChars": 2000,
      "ContractVersion": "fsusblog-antispam-signal-v1"
    }
  }
}
```

The built-in loader reads a model directory containing:

- `manifest.json`
- `runtime_config.json`
- `model_state.json`
- `weights.int8.json`
- `threshold_policy.json`
- `test_vectors.jsonl`
- `manifest.sig` when signature validation is required

The model emits risk signals only. It cannot decide `reject_submit`, `geo_block`, `blocked_regions`, publish, hide, submit action, or display action. Those decisions remain in FsusBlog hard dictionaries, region policy, and the FsusBlog-owned disposition policy.

## Anonymous Field Boundary

FsusBlog model requests and export fixtures use an allowlist. Request metadata may include content and anonymous moderation context only: `source`, `comment_id`, `article_id`, `comment_depth`, `region_policy_version`, `author_mode`, `anonymous_display_language`, `moderation_subject_hash`, `credential_level`, `reputation_bucket`, `account_age_bucket`, `anonymous_comments_enabled`, `zk_anonymous_enabled`, `anonymous_proof_level`, `anonymous_credential_level`, `anonymous_nullifier_hash`, `anonymous_scope`, and `submitted_time_bucket`.

Model requests, result metadata, manifests, release fixtures, and local export tooling must not carry legacy identity fields such as `userId`, `username`, `email`, `ip`, `lastIp`, `authorId`, `replyToUserId`, `accountId`, or `publicHandle`. Hashes and anonymous proof fields are allowed only when they are scoped moderation signals, not account recovery handles.

Production runtime packages must declare a mainline or trusted third-party source. `legacy/python` artifacts from `FsusAntiSpamModel` are audit-only historical references; they may be inspected during migration review, but must not be loaded as the active production model or copied into runtime cache/release bundles.

Runtime reload validates artifact digests, signature policy, runtime format, threshold policy, and `test_vectors.jsonl`. A failed reload keeps the previous active scorer snapshot and records an unavailable/contract-invalid signal or operations event; it must not interrupt the comment moderation path.

Supported disposition modes:

| Mode | Behavior |
| ------ | ---------- |
| `score-only` | Default; store the model signal and keep the comment in `Pending` |
| `auto-low-risk-approve` | Auto-approve only clean high-confidence comments when region policy allows public display and does not require manual review |
| `auto-hide-high-risk` | Auto-hide high-confidence `risky` / `blocked_candidate` comments, or second-round spam/scam/malicious-link signals |
| `strict-auto-moderate` | Auto-approve clean high-confidence signals and auto-hide high-risk signals when region policy permits |

Region policy has higher priority than model disposition. A model signal must not auto-approve when `RegionCanPublish=false`, `RegionRequiresManualReview=true`, or `RegionHideUntilReviewed=true`.

## Signal Storage

When enabled, a comment is inserted as `Pending` before scoring and stores the latest model output in `comment_moderation_signal`. Runtime unavailable, timeout, contract invalid, missing provider DI, and other errors remain `Pending` by default (`FailOpen=false`). Operators may explicitly set `FailOpen=true`; only a region-safe, non-manual, non-anonymous-review comment may then transition to `Approved`.

Admin queue responses include the latest model signal metadata: built-in runtime id, model, contract version, label, confidence, severity, primary reason, risk categories, evidence JSON, raw reason, latency, status, error code, threshold profile, timestamp, and whether the final moderation state was model-auto-applied.

## Audit

Model scoring writes structured audit events:

```text
model_moderation_scored
model_moderation_timeout
model_moderation_unavailable
model_moderation_contract_invalid
model_moderation_error
model_moderation_auto_disposition
```

Audit context contains low-cardinality metadata such as comment id, built-in runtime id, model, contract version, label, confidence, status, error code, disposition mode, reason, next status, and whether the status was auto-applied.

## Queue Usage

The admin comment moderation workbench shows model label, confidence, runtime id, severity, primary reason, raw reason, and whether the comment was model-auto-disposed. Local filters can narrow the current queue by model label or runtime id. Bulk and single manual moderation still require the admin passkey step-up proof flow; model output is never an automatic final decision in the default `score-only` mode.

## Comment Status Transition Matrix

`CommentModerationTransitions` is the single runtime source for manual and model-driven status changes. A state cannot transition to itself, and no state can return to `Pending` after a moderation decision. The machine-readable dashboard source is [`comment-moderation-state-machine.yaml`](moderation/comment-moderation-state-machine.yaml).

| From / To | Pending | Approved | Rejected | Hidden |
| ----------- | --------- | ---------- | ---------- | -------- |
| Pending | denied | allowed | allowed | allowed |
| Approved | denied | denied | allowed | allowed |
| Rejected | denied | allowed | denied | allowed |
| Hidden | denied | allowed | allowed | denied |

Single and bulk admin writes compare the persisted `moderation_status` with the state that was read before the update. Automatic model writes compare both that expected status and PostgreSQL `xmin`; a concurrent winner therefore prevents the stale write and its audit/notification side effects. Successful single and automatic audits carry the previous and next state; bulk audit context records a deterministic `from->to:count` summary.

Operational rollback does not require a process restart: disable the model runtime through the existing moderation runtime control to stop new automatic transitions while preserving hard dictionaries, region policy, and manual review. Re-enabling the model resumes from the current persisted state; the transition matrix still rejects stale, duplicate, and illegal moves.
