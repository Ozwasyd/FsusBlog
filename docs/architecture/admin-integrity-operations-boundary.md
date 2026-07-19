# Admin integrity operations boundary

`IAdminIntegrityOperations` owns the data-consistency inspection and bounded safe
repair use case:

```text
GET  /api/binary/admin/integrity
GET  /api/binary/admin/integrity/fix-preview
POST /api/binary/admin/integrity/fix
  -> IAdminIntegrityOperations
       -> scoped database client
       -> bounded upload filesystem inspection
```

The three endpoints depend on the narrow scoped port directly. Integrity
operations have no dependency on health, backup, artifact action, cache
diagnostic, or dangerous-operation policy services. Those boundaries likewise
never call back into integrity operations.

Check codes, SQL projections, bounded file scanning, preview diffs, confirmation
phrase, admin step-up, audit events, permissions, rate limits, and all AEDS
request/response contracts remain unchanged. Rollback requires no schema or
artifact migration.
