# Admin backup status boundary

`IAdminBackupStatusReader` owns backup and restore evidence discovery:

```text
Admin ops health / backup endpoint
  -> IAdminBackupStatusReader
       -> IConfiguration
       -> IWebHostEnvironment
       -> local backup and key-ring files
```

`AdminOperationsService` consumes the resulting status when composing the health panel, but no longer scans backup directories or exposes a forwarding backup method. The `/ops/backup` endpoint depends on the narrow reader directly. The reader never calls back into the operations service.

Artifact name patterns, latest-file selection, live key-ring fallback, restore-drill evidence paths, required artifact status, and operator command hints remain unchanged. Rollback changes no endpoint, AEDS response, backup file, or restore format.
