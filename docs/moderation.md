# Moderation Runtime

FsusBlog owns the moderation provider contract. `FsusAntiSpamModel` is the first-party reference implementation, and third-party providers can integrate when they conform to the FsusBlog provider contract in [`moderation/third-party-model-development.md`](moderation/third-party-model-development.md).

## Anti-Spam Model

The anti-spam model layer is optional and disabled by default:

```json
{
  "Moderation": {
    "AntiSpamModel": {
      "Enabled": false,
      "Provider": "none",
      "Mode": "score-only",
      "AutoApproveConfidenceThreshold": 0.95,
      "AutoHideConfidenceThreshold": 0.9,
      "FailOpen": true,
      "TimeoutMs": 800,
      "MaxContentChars": 2000,
      "ContractVersion": "fsusblog-moderation-provider-v1"
    }
  }
}
```

Supported provider selectors:

| Provider | Behavior |
|----------|----------|
| `none` | Default; no model call and no signal row |
| `mock` | Local deterministic test signal |
| `http-json` | External HTTP JSON provider; requires `AllowExternalProvider=true` and `ExternalProviderReviewed=true` |
| `fsus-cli` | Reserved until the reference model exposes a stable scoring command |

The model provider emits risk signals only. It cannot decide `reject_submit`, `geo_block`, `blocked_regions`, publish, hide, submit action, or display action. Those decisions remain in FsusBlog hard dictionaries, region policy, and the FsusBlog-owned disposition policy.

Supported disposition modes:

| Mode | Behavior |
|------|----------|
| `score-only` | Default; store the model signal and keep the comment in `Pending` |
| `auto-low-risk-approve` | Auto-approve only clean high-confidence comments when region policy allows public display and does not require manual review |
| `auto-hide-high-risk` | Auto-hide high-confidence `risky` / `blocked_candidate` comments, or second-round spam/scam/malicious-link signals |
| `strict-auto-moderate` | Reserved; currently does not auto-apply a final status |

Region policy has higher priority than model disposition. A model signal must not auto-approve when `RegionCanPublish=false`, `RegionRequiresManualReview=true`, or `RegionHideUntilReviewed=true`.

## Signal Storage

When enabled, comment creation stores the latest model output in `comment_moderation_signal`. Provider timeout, unavailable, contract invalid, and other errors are persisted as fail-open signal rows with `status=timeout|unavailable|contract_invalid|error`; the comment remains in the normal Pending moderation queue.

Admin queue responses include the latest model signal metadata: provider, model, contract version, label, confidence, severity, primary reason, risk categories, evidence JSON, raw reason, latency, status, error code, threshold profile, timestamp, and whether the final moderation state was model-auto-applied.

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

Audit context contains low-cardinality metadata such as comment id, provider, model, contract version, label, confidence, status, error code, disposition mode, reason, next status, and whether the status was auto-applied.

## Queue Usage

The admin comment moderation workbench shows model label, confidence, provider, severity, primary reason, raw reason, and whether the comment was model-auto-disposed. Local filters can narrow the current queue by model label or provider. Bulk and single manual moderation still require the admin passkey step-up proof flow; model output is never an automatic final decision in the default `score-only` mode.
