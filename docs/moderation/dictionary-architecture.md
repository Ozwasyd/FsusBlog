# Moderation Dictionary Architecture

FsusBlog owns the hard dictionary and region policy layer. Model providers can only emit risk signals; they cannot replace dictionary matching, choose legal actions, or return `blocked_regions`.

## Runtime Order

```text
1. Hard dictionaries / ContentFilterService
2. RegionLegalModerationService
3. Optional model provider risk signal
4. Manual moderation
```

Dictionary hits produce `category`, `severity`, `reason`, and redacted evidence according to `evidence_policy`. Region policies map those categories to `submit_action` and `display_action`.

## Files

```text
configs/moderation/
  dictionaries/
    global/*.yaml
    regions/{region}/*.yaml
  region-policies/*.yaml
```

Each dictionary must declare `dictionary_id`, `version`, `scope`, `category`, `source`, `reviewed_by`, `updated_at`, and `terms`. Checksums are computed at load time. Regional dictionaries must declare `region`.

Dictionary categories use the same normalized category set as model-provider signals where possible:

```text
advertising
contact_lead
scam
spam_repeat
malicious_link
html_risk
pornographic
sexual_explicit
sexual_suggestion
political_sensitive
public_order_risk
national_security_risk
hate_speech
terrorism_extremism
gambling
violence_extreme
child_safety
harassment
```

## Snapshot

`ModerationDictionaryService` builds an immutable `ModerationDictionarySnapshot` containing all dictionaries, region policies, checksums, and a snapshot id. Reload builds a new snapshot first and only swaps it in after validation passes. If validation fails, the previous snapshot remains active and `lastError` is updated.

`CN-MAINLAND` policy must include:

```text
cn-mainland.political-sensitive
cn-mainland.porn-strict
cn-mainland.public-order
cn-mainland.national-security
```

CN-MAINLAND strict actions still remain scoped through #73:

```text
submit_region == CN-MAINLAND
or viewer_region == CN-MAINLAND
```

## Admin Metadata

`GET /api/author/moderation/dictionaries` returns snapshot metadata only: dictionary ids, versions, scope, region, category, source, reviewer marker, checksum, term counts, policy ids, and `lastError`. High-risk term text is not exposed by this endpoint.

## Audit

Dictionary reload writes structured `sys_audit_log` records through `AuditLogChannel`:

```text
dictionary_loaded
dictionary_reload_failed
dictionary_checksum_changed
region_policy_loaded
region_policy_reload_failed
region_policy_replay_started
region_policy_replay_completed
```

Audit context is limited to metadata such as `dictionary_id`, `version`, `checksum`, `term_count`, `region`, `policy_version`, and replay diff counts. It must not include term values.

## Replay

Dictionary and region policy changes use `RegionPolicyReplayDiff` to preview blocked-region, risk-label, publishability, and public-visibility changes before applying recomputation.
