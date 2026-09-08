# Atomic account enrollment migration

`20260720-pre-atomic-account-enrollment` is an additive, compatible migration: it adds independent `sys_user.registration_state` and `account_enrollment_session` without deleting old columns or rewriting Passkey/Recovery/session tables.

Classify existing accounts as `active` when they have a Passkey, an unrevoked Recovery Key, or an idle/absolute-valid formal session; `closed` when deleted; and `suspended` when banned with no credentials and no valid session (a candidate orphan). The migration never silently deletes existing accounts. Only the new bootstrap creates `provisional`.

Roll out as expand migration → application supports legacy `active` and new `provisional` accounts → enable the new bootstrap. To roll back, disable bootstrap or route traffic to the old application, retain the columns and enrollment table, and let the 15–30 minute TTL worker clean provisional rows; never drop schema or bulk-mark provisional rows active. If the old application must read again, manually audit historical `suspended` accounts that must remain as `active`; keep the new-column default `active`, so N-1 writes cannot create provisional rows.

Acceptance SQL must verify migration evidence for each `active` account's Passkey, Recovery, or valid-session basis; no formal session for `provisional`; an `active` enrollment completion with both the first credential and formal session; expiry cleanup never targets `active`; and `registration_state` and enrollment state contain only defined enum values.
