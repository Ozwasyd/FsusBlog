using System.Collections.Immutable;
using System.Data.Common;
using System.Diagnostics;
using System.Runtime.ExceptionServices;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// PostgreSQL state authority using the existing scoped SqlSugar client. Each call owns a
/// transaction; callers must not share that client concurrently or supply an ambient transaction.
/// Persistent scope fences serialize independent clients, including after host restart.
/// </summary>
public sealed class PostgresAuthoringExtensionStateStore(ISqlSugarClient db) : IAuthoringFencedExtensionStateStore
{
    private sealed record StoredScope(AuthoringStateSnapshot Snapshot, string? Fence);
    private sealed record StoredMigration(int Phase);

    public async ValueTask InitializeAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken)
    {
        ValidateOwner(package, scope);
        await TransactionAsync([scope], async token =>
        {
            AuthoringStateSnapshot empty = Snapshot(scope, package.PackageIdentity, 0, []);
            _ = await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_extension_state_scope(scope_id, revision, fence, payload)
                VALUES (@ScopeId, 0, NULL, @Payload) ON CONFLICT (scope_id) DO NOTHING;
                """, new SugarParameter("@ScopeId", ScopeId(scope)), new SugarParameter("@Payload", Encode(empty))).ConfigureAwait(false);
            _ = await ReadOwnedAsync(package, scope, token).ConfigureAwait(false);
            return true;
        }, cancellationToken).ConfigureAwait(false);
    }

    public ValueTask<AuthoringStateSnapshot> ReadAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken)
    {
        ValidateOwner(package, scope);
        return TransactionAsync([scope], async token =>
        {
            StoredScope stored = await ReadOwnedAsync(package, scope, token).ConfigureAwait(false);
            Require(stored.Fence is null, "state_scope_fenced");
            return stored.Snapshot;
        }, cancellationToken);
    }

    public async ValueTask WriteAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, long expectedRevision, AuthoringStateEntry entry, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateOwner(package, scope);
        // Copy caller-owned bytes before the first await.
        AuthoringStateSnapshot input = Snapshot(scope, package.PackageIdentity, expectedRevision, [entry]);
        await TransactionAsync([scope], async token =>
        {
            StoredScope stored = await ReadOwnedAsync(package, scope, token).ConfigureAwait(false);
            Require(stored.Fence is null && stored.Snapshot.Revision == expectedRevision, "state_write_fenced_or_stale");
            var values = stored.Snapshot.Entries.ToDictionary(static item => item.Key, StringComparer.Ordinal);
            values[input.Entries[0].Key] = input.Entries[0];
            AuthoringStateSnapshot next = Snapshot(scope, package.PackageIdentity, checked(expectedRevision + 1), values.Values);
            await SaveAsync(stored, next, null).ConfigureAwait(false);
            return true;
        }, cancellationToken).ConfigureAwait(false);
    }

    public ValueTask<AuthoringStateMeasurement> MeasureAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken cancellationToken)
    {
        ValidateOwner(package, scope);
        return TransactionAsync([scope], async token =>
        {
            StoredScope stored = await ReadOwnedAsync(package, scope, token).ConfigureAwait(false);
            Require(stored.Fence is null, "state_scope_fenced");
            return await MeasureCoreAsync(stored.Snapshot, token).ConfigureAwait(false);
        }, cancellationToken);
    }

    public async ValueTask DeleteAsync(VerifiedAuthoringPackage package, AuthoringFencedStateDeletion approval, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(approval);
        ArgumentNullException.ThrowIfNull(approval.Expected);
        ValidateOwner(package, approval.Expected.Scope);
        Require(IsField(approval.ApprovalReceiptId, 256), "state_delete_approval_missing");
        await TransactionAsync([approval.Expected.Scope], async token =>
        {
            StoredScope stored = await ReadOwnedAsync(package, approval.Expected.Scope, token).ConfigureAwait(false);
            Require(stored.Fence is null, "state_scope_fenced");
            AuthoringStateMeasurement current = await MeasureCoreAsync(stored.Snapshot, token).ConfigureAwait(false);
            Require(current == approval.Expected, "state_delete_approval_stale");
            await SaveAsync(stored, Snapshot(current.Scope, package.PackageIdentity, checked(current.Revision + 1), []), null)
                .ConfigureAwait(false);
            _ = await db.Ado.ExecuteCommandAsync(
                "DELETE FROM authoring_extension_state_backup WHERE scope_id = @ScopeId;",
                new SugarParameter("@ScopeId", ScopeId(current.Scope))).ConfigureAwait(false);
            return true;
        }, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask BackupAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken)
    {
        var prepared = PreparePlan(oldPackage, newPackage, plan, cancellationToken);
        plan = prepared.Plan;
        await TransactionAsync([plan.From, plan.To], async token =>
        {
            StoredMigration? previous = await ReadMigrationAsync(plan, token).ConfigureAwait(false);
            if (previous is not null)
            {
                Require(previous.Phase is 0 or 1, "state_migration_already_settled");
                await ReadFencedAsync(oldPackage, newPackage, plan, previous.Phase, token).ConfigureAwait(false);
                return true;
            }
            StoredScope from = await ReadOwnedAsync(oldPackage, plan.From, token).ConfigureAwait(false);
            StoredScope to = await ReadOwnedAsync(newPackage, plan.To, token).ConfigureAwait(false);
            Require(from.Fence is null && to.Fence is null &&
                from.Snapshot.Revision == plan.ExpectedFromRevision && to.Snapshot.Revision == plan.ExpectedToRevision &&
                from.Snapshot.ContentSha256 == plan.SourceContentSha256 && to.Snapshot.Entries.IsEmpty,
                "state_backup_stale_fenced_or_target_exists");
            _ = Transform(from.Snapshot, plan, token);
            await RequireBackupCapacityAsync(from.Snapshot, token).ConfigureAwait(false);
            await RequireBackupCapacityAsync(to.Snapshot, token).ConfigureAwait(false);
            _ = await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_extension_state_migration(plan_id, plan_sha256, from_scope_id, to_scope_id, phase)
                VALUES (@PlanId, @Digest, @FromId, @ToId, 0);
                """, Parameters(plan)).ConfigureAwait(false);
            foreach (StoredScope stored in new[] { from, to })
            {
                _ = await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO authoring_extension_state_backup(plan_id, scope_id, payload)
                    VALUES (@PlanId, @ScopeId, @Payload);
                    """, new SugarParameter("@PlanId", PlanId(plan)),
                    new SugarParameter("@ScopeId", ScopeId(stored.Snapshot.Scope)),
                    new SugarParameter("@Payload", Encode(stored.Snapshot))).ConfigureAwait(false);
                await SaveAsync(stored, Advance(stored.Snapshot), plan.ContentSha256).ConfigureAwait(false);
            }
            return true;
        }, cancellationToken, prepared.Remaining).ConfigureAwait(false);
    }

    public async ValueTask<AuthoringStateSnapshot> ApplyAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken)
    {
        var prepared = PreparePlan(oldPackage, newPackage, plan, cancellationToken);
        plan = prepared.Plan;
        return await TransactionAsync([plan.From, plan.To], async token =>
        {
            StoredMigration migration = await RequireMigrationAsync(plan, token).ConfigureAwait(false);
            Require(migration.Phase is 0 or 1, "state_migration_already_settled");
            (_, StoredScope to, AuthoringStateSnapshot backupFrom, _) =
                await ReadFencedAsync(oldPackage, newPackage, plan, migration.Phase, token).ConfigureAwait(false);
            if (migration.Phase == 1)
            {
                return to.Snapshot;
            }
            ImmutableArray<AuthoringStateEntry> transformed = Transform(backupFrom, plan, token);
            AuthoringStateSnapshot applied = Snapshot(plan.To, newPackage.PackageIdentity, checked(to.Snapshot.Revision + 1), transformed);
            await SaveAsync(to, applied, plan.ContentSha256).ConfigureAwait(false);
            await ChangePhaseAsync(plan, 0, 1).ConfigureAwait(false);
            return applied;
        }, cancellationToken, prepared.Remaining).ConfigureAwait(false);
    }

    public ValueTask RollbackAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken) =>
        SettleAsync(oldPackage, newPackage, plan, rollback: true, cancellationToken);

    public ValueTask CompleteAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken) =>
        SettleAsync(oldPackage, newPackage, plan, rollback: false, cancellationToken);

    private async ValueTask SettleAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, bool rollback, CancellationToken cancellationToken)
    {
        var prepared = PreparePlan(oldPackage, newPackage, plan, cancellationToken);
        plan = prepared.Plan;
        await TransactionAsync([plan.From, plan.To], async token =>
        {
            StoredMigration migration = await RequireMigrationAsync(plan, token).ConfigureAwait(false);
            int terminal = rollback ? 2 : 3;
            if (migration.Phase == terminal)
            {
                // A settled retry cannot rewind subsequent writes or resurrect purged backups.
                return true;
            }
            Require(rollback ? migration.Phase is 0 or 1 : migration.Phase == 1, "state_migration_phase_conflict");
            (StoredScope from, StoredScope to, AuthoringStateSnapshot backupFrom, AuthoringStateSnapshot backupTo) =
                await ReadFencedAsync(oldPackage, newPackage, plan, migration.Phase, token).ConfigureAwait(false);
            await SaveAsync(from, Advance(rollback ? backupFrom : from.Snapshot, from.Snapshot.Revision), null).ConfigureAwait(false);
            await SaveAsync(to, Advance(rollback ? backupTo : to.Snapshot, to.Snapshot.Revision), null).ConfigureAwait(false);
            await ChangePhaseAsync(plan, migration.Phase, terminal).ConfigureAwait(false);
            return true;
        }, cancellationToken, prepared.Remaining).ConfigureAwait(false);
    }

    private async Task<(StoredScope From, StoredScope To, AuthoringStateSnapshot BackupFrom, AuthoringStateSnapshot BackupTo)> ReadFencedAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, int phase, CancellationToken token)
    {
        StoredScope from = await ReadOwnedAsync(oldPackage, plan.From, token).ConfigureAwait(false);
        StoredScope to = await ReadOwnedAsync(newPackage, plan.To, token).ConfigureAwait(false);
        AuthoringStateSnapshot backupFrom = await ReadBackupAsync(plan, plan.From, token).ConfigureAwait(false);
        AuthoringStateSnapshot backupTo = await ReadBackupAsync(plan, plan.To, token).ConfigureAwait(false);
        Require(backupFrom.Revision == plan.ExpectedFromRevision && backupTo.Revision == plan.ExpectedToRevision &&
            backupFrom.PackageIdentity == oldPackage.PackageIdentity && backupTo.PackageIdentity == newPackage.PackageIdentity &&
            backupFrom.ContentSha256 == plan.SourceContentSha256 && backupTo.Entries.IsEmpty &&
            from.Fence == plan.ContentSha256 && to.Fence == plan.ContentSha256 &&
            from.Snapshot.Revision == checked(plan.ExpectedFromRevision + 1) &&
            to.Snapshot.Revision == checked(plan.ExpectedToRevision + 1 + phase) &&
            from.Snapshot.ContentSha256 == Advance(backupFrom).ContentSha256,
            "state_migration_fence_or_backup_tampered");
        ImmutableArray<AuthoringStateEntry> entries = phase == 0 ? backupTo.Entries : Transform(backupFrom, plan, token);
        Require(to.Snapshot.ContentSha256 == Snapshot(plan.To, newPackage.PackageIdentity, to.Snapshot.Revision, entries).ContentSha256,
            "state_migration_target_tampered");
        return (from, to, backupFrom, backupTo);
    }

    private async Task<StoredScope> ReadOwnedAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken token)
    {
        StoredScope stored = await ReadScopeAsync(scope, token).ConfigureAwait(false);
        Require(stored.Snapshot.PackageIdentity == package.PackageIdentity, "state_package_identity_drifted");
        return stored;
    }

    private async Task<StoredScope> ReadScopeAsync(AuthoringStateScope scope, CancellationToken token)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT revision, fence, payload FROM authoring_extension_state_scope WHERE scope_id = @ScopeId;",
            new SugarParameter("@ScopeId", ScopeId(scope))).ConfigureAwait(false);
        Require(await reader.ReadAsync(token).ConfigureAwait(false), "state_scope_unknown");
        AuthoringStateSnapshot snapshot = DecodeSnapshot(reader.GetFieldValue<byte[]>(2));
        Require(snapshot.Scope == scope && snapshot.Revision == reader.GetInt64(0), "state_scope_or_revision_tampered");
        string? fence = reader.IsDBNull(1) ? null : reader.GetString(1);
        Require(fence is null || IsDigest(fence), "state_fence_invalid");
        return new(snapshot, fence);
    }

    private async Task<AuthoringStateSnapshot> ReadBackupAsync(AuthoringFencedStateMigration plan, AuthoringStateScope scope, CancellationToken token)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT payload FROM authoring_extension_state_backup WHERE plan_id = @PlanId AND scope_id = @ScopeId;",
            new SugarParameter("@PlanId", PlanId(plan)), new SugarParameter("@ScopeId", ScopeId(scope))).ConfigureAwait(false);
        Require(await reader.ReadAsync(token).ConfigureAwait(false), "state_backup_missing");
        AuthoringStateSnapshot snapshot = DecodeSnapshot(reader.GetFieldValue<byte[]>(0));
        Require(snapshot.Scope == scope, "state_backup_cross_scope");
        return snapshot;
    }

    private async Task<StoredMigration?> ReadMigrationAsync(AuthoringFencedStateMigration plan, CancellationToken token)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT phase, plan_sha256, from_scope_id, to_scope_id FROM authoring_extension_state_migration WHERE plan_id = @PlanId;",
            new SugarParameter("@PlanId", PlanId(plan))).ConfigureAwait(false);
        if (!await reader.ReadAsync(token).ConfigureAwait(false))
        {
            return null;
        }
        int phase = reader.GetInt16(0);
        Require(phase is >= 0 and <= 3 && reader.GetString(1) == plan.ContentSha256 &&
            reader.GetString(2) == ScopeId(plan.From) && reader.GetString(3) == ScopeId(plan.To),
            "state_plan_identity_conflict_or_tampered");
        return new(phase);
    }

    private async Task<StoredMigration> RequireMigrationAsync(AuthoringFencedStateMigration plan, CancellationToken token) =>
        await ReadMigrationAsync(plan, token).ConfigureAwait(false)
            ?? throw new AuthoringExtensionContractException("state_migration_unknown");

    private async Task<AuthoringStateMeasurement> MeasureCoreAsync(AuthoringStateSnapshot snapshot, CancellationToken token)
    {
        var backups = new List<object>();
        long records = snapshot.Entries.Length;
        long bytes = ValueBytes(snapshot);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT b.plan_id, b.payload, m.phase FROM authoring_extension_state_backup b
            JOIN authoring_extension_state_migration m ON m.plan_id = b.plan_id
            WHERE b.scope_id = @ScopeId ORDER BY b.plan_id COLLATE "C";
            """, new SugarParameter("@ScopeId", ScopeId(snapshot.Scope))).ConfigureAwait(false);
        while (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            Require(backups.Count < MaximumBackups && reader.GetInt16(2) is 2 or 3, "state_backup_unsettled_or_unbounded");
            AuthoringStateSnapshot backup = DecodeSnapshot(reader.GetFieldValue<byte[]>(1));
            Require(backup.Scope == snapshot.Scope && backup.PackageIdentity == snapshot.PackageIdentity &&
                backup.Revision < snapshot.Revision, "state_backup_identity_invalid");
            records = checked(records + backup.Entries.Length);
            bytes = checked(bytes + ValueBytes(backup));
            backups.Add(new
            {
                PlanId = reader.GetString(0),
                backup.ContentSha256
            });
        }
        string digest = Digest(new
        {
            Kind = "authoring-state-measurement-v1",
            snapshot.ContentSha256,
            Backups = backups
        });
        return new(snapshot.Scope, snapshot.Revision, records, bytes, digest);
    }

    private async Task RequireBackupCapacityAsync(AuthoringStateSnapshot snapshot, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        object count = await db.Ado.GetScalarAsync(
            "SELECT COUNT(*) FROM authoring_extension_state_backup WHERE scope_id = @ScopeId;",
            new SugarParameter("@ScopeId", ScopeId(snapshot.Scope))).ConfigureAwait(false);
        Require(Convert.ToInt64(count, System.Globalization.CultureInfo.InvariantCulture) < MaximumBackups, "state_backup_retention_limit");
    }

    private async Task SaveAsync(StoredScope expected, AuthoringStateSnapshot next, string? fence)
    {
        Require(next.Scope == expected.Snapshot.Scope && next.PackageIdentity == expected.Snapshot.PackageIdentity &&
            next.Revision == checked(expected.Snapshot.Revision + 1), "state_revision_not_monotonic");
        int changed = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE authoring_extension_state_scope SET revision = @Revision, fence = @Fence, payload = @Payload
            WHERE scope_id = @ScopeId AND revision = @ExpectedRevision AND fence IS NOT DISTINCT FROM @ExpectedFence;
            """, new SugarParameter("@Revision", next.Revision), new SugarParameter("@Fence", fence),
            new SugarParameter("@Payload", Encode(next)), new SugarParameter("@ScopeId", ScopeId(next.Scope)),
            new SugarParameter("@ExpectedRevision", expected.Snapshot.Revision), new SugarParameter("@ExpectedFence", expected.Fence))
            .ConfigureAwait(false);
        Require(changed == 1, "state_revision_cas_stale");
    }

    private async Task ChangePhaseAsync(AuthoringFencedStateMigration plan, int expected, int phase)
    {
        int changed = await db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_extension_state_migration SET phase = @Phase WHERE plan_id = @PlanId AND phase = @Expected AND plan_sha256 = @Digest;",
            new SugarParameter("@Phase", phase), new SugarParameter("@PlanId", PlanId(plan)),
            new SugarParameter("@Expected", expected), new SugarParameter("@Digest", plan.ContentSha256)).ConfigureAwait(false);
        Require(changed == 1, "state_migration_phase_cas_stale");
    }

    private static AuthoringStateSnapshot Advance(AuthoringStateSnapshot snapshot, long? revision = null) =>
        Snapshot(snapshot.Scope, snapshot.PackageIdentity, checked((revision ?? snapshot.Revision) + 1), snapshot.Entries);

    private static (AuthoringFencedStateMigration Plan, TimeSpan Remaining) PreparePlan(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, plan);
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan remaining = frozen.MaximumDuration - Stopwatch.GetElapsedTime(started);
        if (remaining <= TimeSpan.Zero)
        {
            throw new TimeoutException("state_migration_admission_duration_exceeded");
        }
        return (frozen, remaining);
    }

    private static SugarParameter[] Parameters(AuthoringFencedStateMigration plan) =>
    [
        new("@PlanId", PlanId(plan)), new("@Digest", plan.ContentSha256),
        new("@FromId", ScopeId(plan.From)), new("@ToId", ScopeId(plan.To))
    ];

    private async ValueTask<T> TransactionAsync<T>(AuthoringStateScope[] scopes, Func<CancellationToken, Task<T>> action, CancellationToken cancellationToken, TimeSpan? duration = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(db.Ado.Transaction is null, "state_ambient_transaction_not_supported");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(duration ?? TimeSpan.FromSeconds(30));
        T result = default!;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            CancellationToken? previous = db.Ado.CancellationToken;
            db.Ado.CancellationToken = timeout.Token;
            try
            {
                _ = await db.Ado.GetScalarAsync("SELECT set_config('statement_timeout', @Timeout, true);",
                    new SugarParameter("@Timeout", Math.Max(1, (long)(duration ?? TimeSpan.FromSeconds(30)).TotalMilliseconds)
                        .ToString(System.Globalization.CultureInfo.InvariantCulture))).ConfigureAwait(false);
                foreach (string id in scopes.Select(ScopeId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
                {
                    _ = await db.Ado.GetScalarAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2143));",
                        new SugarParameter("@Identity", $"authoring-extension-state:{id}")).ConfigureAwait(false);
                }
                result = await action(timeout.Token).ConfigureAwait(false);
                timeout.Token.ThrowIfCancellationRequested();
            }
            finally
            {
                // Rollback retains its transaction owner even when the operation was cancelled.
                db.Ado.CancellationToken = previous;
            }
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                ExceptionDispatchInfo.Capture(transaction.ErrorException).Throw();
            }
            throw new InvalidOperationException("authoring_state_transaction_failed");
        }
        return result;
    }

    public ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => Unfenced();
    public ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => Unfenced();
    public ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => Unfenced();
    public ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken) => Unfenced();

    public async ValueTask<(long Records, long Bytes)> MeasureAsync(AuthoringStateScope scope, CancellationToken cancellationToken)
    {
        ValidateScope(scope);
        AuthoringStateMeasurement measurement = await TransactionAsync([scope], async token =>
        {
            StoredScope stored = await ReadScopeAsync(scope, token).ConfigureAwait(false);
            Require(stored.Fence is null, "state_scope_fenced");
            return await MeasureCoreAsync(stored.Snapshot, token).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        return (measurement.Records, measurement.Bytes);
    }

    private static ValueTask Unfenced() => ValueTask.FromException(new AuthoringExtensionContractException("state_operation_requires_explicit_fenced_v1_contract"));
}
