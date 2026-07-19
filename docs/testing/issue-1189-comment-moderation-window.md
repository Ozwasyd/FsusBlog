# Issue 1189 Comment Moderation Window Verification

The focused suite covers the state window and its public side effects:

- logged-in deterministic low risk with model disabled starts `Approved`;
- model-required submission starts `Pending`, including provider DI missing;
- anonymous credential `RequiresModeration` starts `Pending`;
- region manual review starts `Pending`, and hide-until-reviewed starts `Hidden`;
- score-only, timeout/unavailable, explicit fail-open, clean auto-approval and risky auto-hide dispositions;
- optimistic state plus `xmin` guards prevent a model result overwriting concurrent admin moderation;
- `Pending -> Approved` invalidates public caches and emits `CommentAdded`; non-public creation does neither;
- binary `CommentCreateResult` POD/frame decoding rejects malformed flags, states and trailing bytes;
- migration registry and PostgreSQL integration verify initial/transition events and append-only enforcement;
- public comment/thread queries continue to require `Approved`, while `/comment/me` and admin queues distinguish all moderation states.

The endpoint/security matrix also retains anonymous request contamination checks, logged-in account requirements, admin Passkey step-up for manual moderation, notification stream framing and AEDS-only error behavior.
