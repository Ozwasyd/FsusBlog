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
