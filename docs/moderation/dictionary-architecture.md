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
  regions.yaml
  policy-templates/*.yaml
  dictionaries/
    global/*.yaml
    regions/{region}/*.yaml
  region-policies/*.yaml
```

Each dictionary must declare `dictionary_id`, `version`, `scope`, `category`, `source`, `reviewed_by`, `updated_at`, and `terms`. Checksums are computed at load time. Regional dictionaries must declare `region`.

`regions.yaml` defines built-in and operator custom regions plus region groups. `policy-templates/*.yaml` defines engineering presets with `template_id`, `version`, `source`, `reviewed_by`, `reviewed_at_utc`, `not_legal_advice`, checksum-at-load, and rules. Templates are configuration presets, not legal advice; operators must review them against actual service regions, deployment location, business type, and legal counsel.

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

`GREATER_CHINA` is a region group, not the CN-MAINLAND strict policy. `CN-HK`, `CN-MO`, and `CN-TW` do not inherit `cn-mainland-strict` unless an operator explicitly configures that override.

Effective policy preview is resolved as:

```text
GLOBAL baseline
  -> region group policy
  -> parent region policy
  -> concrete region policy
  -> operator overrides
```

Later layers override earlier layers by category. Model providers never decide effective policy, legal region status, or `blocked_regions`.

## Admin Metadata

`GET /api/binary/author/moderation/dictionaries` returns snapshot metadata only: dictionary ids, versions, scope, region, category, source, reviewer marker, checksum, term counts, policy ids, and `lastError`. High-risk term text is not exposed by this endpoint.

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
