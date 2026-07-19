# User identity query boundary

`UserAccountReader` owns the account identity projection and its versioned cache:

```text
IUserAccountReader
  -> account-snapshot version cache
  -> sys_user projection query
  -> subject-hash validation
  -> account-snapshot payload cache
```

The reader no longer forwards database work through `UserService`. It depends
directly on `ISqlSugarClient` and the four narrow cache ports required by this
single read use case. Invalid or legacy snapshots without a valid account
subject hash are removed instead of being served.

No endpoint or projection field changed. Disabling the snapshot cache still
falls back to the same database query, so the read path can degrade without a
restart.
