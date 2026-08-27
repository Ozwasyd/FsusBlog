# Comment attribution and privacy boundary

`ICommentAttributionPrivacyService` owns identity selection and anonymous
privacy controls for comment creation:

```text
comment command
  -> ICommentAttributionPrivacyService
       -> public actor resolution
       -> anonymous policy and proof readiness
       -> one-time ticket validation and display identity
       -> transactional nullifier consumption
       -> privacy-safe abuse risk signal
```

The comment command passes the resolved actor into its database transaction and
invokes nullifier consumption through this narrow boundary before commit. Raw
anonymous scopes remain out of logs; only a short SHA-256-derived scope marker
is exposed for diagnostics. The attribution service never calls back into
comment command, query, moderation, or notification services.

This extraction changes no endpoint or stored identity contract. Anonymous
submissions continue to fail closed when policy, proof, ticket, or nullifier
dependencies are unavailable. Operators can disable anonymous comments through
the existing runtime policy without restarting or affecting public comments.
## Current persisted comment fields

<!-- fsus-doc-claim
claimId: article-comment-lifecycle-outbox.persisted-fields
behaviorId: article-comment-lifecycle-outbox
claimType: generated-section
generatedSectionId: content.comment.persisted-fields
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN content.comment.persisted-fields -->
- `account_age_bucket`
- `anonymous_display_language`
- `anonymous_display_name`
- `anonymous_handle`
- `anonymous_nullifier_hash`
- `anonymous_rate_class`
- `anonymous_scope`
- `anonymous_ticket_hash`
- `author_mode`
- `credential_level`
- `moderation_subject_hash`
- `public_handle`
- `reputation_bucket`
<!-- FSUSBLOG-GENERATED:END content.comment.persisted-fields -->
