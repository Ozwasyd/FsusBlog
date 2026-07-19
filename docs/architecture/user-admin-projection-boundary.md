# User admin projection boundary

`UserAdminModerationService` owns the administrative account projection and
status transition use cases. It queries and conditionally updates `sys_user`
directly instead of forwarding through `UserService`.

The list projection uses bounded keyset windows, explicit identity-safe fields,
and account-id, identity-kind, or public-handle-prefix search plans. Status
changes retain the PostgreSQL `xmin` guard, deleted/admin-principal protection,
blacklist synchronization, account notification, and snapshot-version bump.

No endpoint or response contract changed. The core gateway now depends on this
narrow admin port for list and status operations. Notification delivery remains
best effort and does not roll back a committed account-state transition.
