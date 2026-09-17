# Destructive schema rollback-window proof

`DropColumnStep` and `DropTableStep` are Contract-only operations. Each step must carry a
`DestructiveMigrationProof` whose migration id matches its descriptor and whose source commit,
introduction time, earliest Contract release, 30-day rollback-window end, proof artifact and
required qualification/restore evidence are explicit.

## Inventory truth

Issue #1127 reported 44 destructive steps. At inventory commit
`71fe04dcf7d930ab42090045920dca9cddf3fdaf`, read-event retirement had added two `DropTableStep`
instances, so the executable inventory contains 46 steps across 18 descriptors. The checked-in
[proof manifest](destructive-rollback-window-proofs.json) records that drift rather than preserving
the stale count. Source SHAs and timestamps were resolved from `git blame`/`git show`; CI checks the
manifest against the registry and, when full history is present, checks each source commit.

The manifest is proof metadata, not a claim that an operational restore drill has occurred. Before
Contract execution, release evidence still has to seal all five requirements:

- N/N-1 qualification passed;
- rollback manifest sealed;
- backup restore verified;
- WAL restore verified;
- cross-region restore verified.

The online migration gate already consumes those operational facts. The cold-start runner and
online descriptor executor now validate the immutable step proof before opening the descriptor
transaction. An open window fails with `schema_destructive_rollback_window_open` and names the
required manifest anchor. A genuinely empty database may bootstrap because it contains neither
prior-release data nor an old release rollback dependency; any pre-existing table disables that
exception.

## Rollback and downgrade

Do not bypass the guard. Before Contract, keep the compatibility columns/tables and continue with
the N/N-1-capable application image; this needs no restart-specific migration action. After Contract,
an image rollback cannot recreate deleted data: isolate writes and restore the verified pre-Contract
site package/database dump according to `tools/operations/backup-restore-drill.sh`.

The quarterly real drill is operational evidence and must not be replaced by a dry-run fixture.
This change adds the local executable contract and does not claim that an external or production
drill was performed.

## Local verification

```bash
node --test tests/tools/destructive-migration-proof.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~DestructiveMigrationProofTests
node tools/check-test-matrix.mjs
```
