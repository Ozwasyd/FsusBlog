using System.Collections.Immutable;
using System.Data;

using Npgsql;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed partial class PostgresAuthoringExtensionStateStore
{
    public ValueTask<IAuthoringExtensionStateObservation> ObserveInitialAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken)
    {
        plan = FreezePlan(oldPackage, newPackage, plan);
        return HoldAsync([plan.From, plan.To],
            (store, token) => store.ReadMigrationObservationAsync(oldPackage, newPackage, plan, null, token), null, cancellationToken);
    }

    public ValueTask<IAuthoringExtensionStateObservation> ObserveFencedAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        AuthoringStateMigrationPhase phase, CancellationToken cancellationToken)
    {
        plan = FreezePlan(oldPackage, newPackage, plan);
        Require(phase is AuthoringStateMigrationPhase.BackedUp or AuthoringStateMigrationPhase.Applied, "state_observation_phase_invalid");
        return HoldAsync([plan.From, plan.To],
            (store, token) => store.ReadMigrationObservationAsync(oldPackage, newPackage, plan, phase, token), null, cancellationToken);
    }

    public ValueTask<IAuthoringExtensionStateObservation> CompleteAndObserveAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken) =>
        SettleAndObserveAsync(oldPackage, newPackage, plan, rollback: false, cancellationToken);

    public ValueTask<IAuthoringExtensionStateObservation> RollbackAndObserveAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken cancellationToken) =>
        SettleAndObserveAsync(oldPackage, newPackage, plan, rollback: true, cancellationToken);

    private async ValueTask<IAuthoringExtensionStateObservation> SettleAndObserveAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, bool rollback, CancellationToken cancellationToken)
    {
        plan = FreezePlan(oldPackage, newPackage, plan);
        // Capture actual settled rows inside the effects transaction; acquire custody only after commit.
        AuthoringStateObservation actual = (await SettleAsync(oldPackage, newPackage, plan, rollback, capture: true, cancellationToken)
            .ConfigureAwait(false))!;
        return await HoldAsync([plan.From, plan.To],
            (store, token) => store.ReadMigrationObservationAsync(oldPackage, newPackage, plan, actual.Phase, token), actual, cancellationToken)
            .ConfigureAwait(false);
    }

    public ValueTask<IAuthoringExtensionStateObservation> ObserveDeletionAsync(
        VerifiedAuthoringPackage package, AuthoringStateMeasurement expected, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(expected);
        ValidateOwner(package, expected.Scope);
        return HoldAsync([expected.Scope], async (store, token) =>
        {
            AuthoringStateObservation actual = await store.ReadDeletionObservationAsync(package, expected.Scope, token).ConfigureAwait(false);
            Require(actual.From.Measurement == expected, "state_delete_approval_stale");
            return actual;
        }, null, cancellationToken);
    }

    public async ValueTask<IAuthoringExtensionStateObservation> DeleteAndObserveAsync(
        VerifiedAuthoringPackage package, AuthoringFencedStateDeletion approval, CancellationToken cancellationToken)
    {
        AuthoringStateObservation actual = (await DeleteCoreAsync(package, approval, capture: true, cancellationToken).ConfigureAwait(false))!;
        return await HoldAsync([actual.From.Snapshot.Scope],
            (store, token) => store.ReadDeletionObservationAsync(package, actual.From.Snapshot.Scope, token), actual, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<AuthoringStateObservation> ReadDeletionObservationAsync(
        VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken token)
    {
        StoredScope stored = await ReadOwnedAsync(package, scope, token).ConfigureAwait(false);
        Require(stored.Fence is null, "state_scope_fenced");
        return new(await ObserveScopeAsync(stored, null, token).ConfigureAwait(false), null, null);
    }

    private async Task<AuthoringStateObservation> ReadMigrationObservationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        AuthoringStateMigrationPhase? phase, CancellationToken token)
    {
        StoredScope from;
        StoredScope to;
        string? activePlanId = null;
        if (phase is AuthoringStateMigrationPhase.BackedUp or AuthoringStateMigrationPhase.Applied)
        {
            StoredMigration migration = await RequireMigrationAsync(plan, token).ConfigureAwait(false);
            Require(migration.Phase == (int)phase, "state_observation_phase_drifted");
            (from, to, _, _) = await ReadFencedAsync(oldPackage, newPackage, plan, migration.Phase, token).ConfigureAwait(false);
            activePlanId = PlanId(plan);
        }
        else
        {
            from = await ReadOwnedAsync(oldPackage, plan.From, token).ConfigureAwait(false);
            to = await ReadOwnedAsync(newPackage, plan.To, token).ConfigureAwait(false);
            Require(from.Fence is null && to.Fence is null, "state_scope_fenced");
            if (phase is null)
            {
                Require(await ReadMigrationAsync(plan, token).ConfigureAwait(false) is null &&
                    from.Snapshot.Revision == plan.ExpectedFromRevision && to.Snapshot.Revision == plan.ExpectedToRevision &&
                    from.Snapshot.ContentSha256 == plan.SourceContentSha256 && to.Snapshot.Entries.IsEmpty,
                    "state_initial_observation_stale");
                _ = Transform(from.Snapshot, plan, token);
            }
            else
            {
                StoredMigration migration = await RequireMigrationAsync(plan, token).ConfigureAwait(false);
                Require(migration.Phase == (int)phase, "state_observation_phase_drifted");
            }
        }
        return new(await ObserveScopeAsync(from, activePlanId, token).ConfigureAwait(false),
            await ObserveScopeAsync(to, activePlanId, token).ConfigureAwait(false), phase);
    }

    private async Task<AuthoringObservedState> ObserveScopeAsync(StoredScope scope, string? activePlanId, CancellationToken token) =>
        new(scope.Snapshot, scope.Fence, await MeasureCoreAsync(scope.Snapshot, token, activePlanId).ConfigureAwait(false));

    private async ValueTask<IAuthoringExtensionStateObservation> HoldAsync(
        AuthoringStateScope[] scopes,
        Func<PostgresAuthoringExtensionStateStore, CancellationToken, Task<AuthoringStateObservation>> read,
        AuthoringStateObservation? expected, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(db.Ado.Transaction is null, "state_ambient_transaction_not_supported");
        // No inherited AOP, auto-close, ambient enlistment, multiplexing or pooled session custody.
        var connection = new NpgsqlConnectionStringBuilder(db.CurrentConnectionConfig.ConnectionString)
        {
            Pooling = false,
            Enlist = false,
            Multiplexing = false
        };
        var owned = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.PostgreSQL,
            ConnectionString = connection.ConnectionString,
            IsAutoCloseConnection = false,
            InitKeyType = InitKeyType.Attribute
        });
        ImmutableArray<string> ids = scopes.Select(ScopeId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToImmutableArray();
        var held = new StateObservationScope(owned, read, ids, cancellationToken);
        try
        {
            await owned.Ado.BeginTranAsync(IsolationLevel.ReadCommitted).ConfigureAwait(false);
            held.BindConnection();
            owned.Ado.CancellationToken = cancellationToken;
            _ = await owned.Ado.GetScalarAsync("SELECT set_config('statement_timeout', '30000', true);").ConfigureAwait(false);
            foreach (string id in ids)
            {
                _ = await owned.Ado.GetScalarAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2143));",
                    new SugarParameter("@Identity", $"authoring-extension-state:{id}")).ConfigureAwait(false);
            }
            AuthoringStateObservation actual;
            try
            {
                actual = await read(new(owned), cancellationToken).ConfigureAwait(false);
            }
            catch (AuthoringExtensionContractException) when (expected is not null)
            {
                throw new AuthoringExtensionContractException("state_observation_drift_requires_recovery");
            }
            Require(expected is null || Digest(actual) == Digest(expected), "state_observation_drift_requires_recovery");
            held.Capture(actual);
            await held.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
            return held;
        }
        catch
        {
            await held.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private sealed class StateObservationScope(
        SqlSugarClient owned,
        Func<PostgresAuthoringExtensionStateStore, CancellationToken, Task<AuthoringStateObservation>> read,
        ImmutableArray<string> ids,
        CancellationToken lifetime) : IAuthoringExtensionStateObservation
    {
        private readonly SemaphoreSlim _gate = new(1, 1);
        private CancellationTokenRegistration _registration;
        private AuthoringStateObservation? _state;
        private bool _disposed;
        private string? _digest;

        public AuthoringStateObservation State => _state ?? throw new InvalidOperationException("state_observation_not_acquired");
        public ImmutableArray<string> AcquiredScopeIds => ids;

        internal void BindConnection()
        {
            // Closing this unpooled owned connection releases custody even while idle or blocked.
            _registration = lifetime.Register(static state => ((IDbConnection)state!).Close(), owned.Ado.Connection);
        }

        internal void Capture(AuthoringStateObservation state)
        {
            _state = state;
            _digest = Digest(state);
        }

        public async ValueTask VerifyCurrentAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(lifetime, cancellationToken);
                try
                {
                    linked.Token.ThrowIfCancellationRequested();
                    Require(!_disposed && owned.Ado.Transaction?.Connection?.State == ConnectionState.Open,
                        "state_observation_custody_lost");
                    owned.Ado.CancellationToken = linked.Token;
                    AuthoringStateObservation current;
                    try
                    {
                        current = await read(new(owned), linked.Token).ConfigureAwait(false);
                    }
                    catch (AuthoringExtensionContractException)
                    {
                        throw new AuthoringExtensionContractException("state_observation_drift_requires_recovery");
                    }
                    linked.Token.ThrowIfCancellationRequested();
                    Require(owned.Ado.Transaction?.Connection?.State == ConnectionState.Open && _digest == Digest(current),
                        "state_observation_drift_requires_recovery");
                }
                catch
                {
                    await ReleaseAsync().ConfigureAwait(false);
                    throw;
                }
                finally
                {
                    owned.Ado.CancellationToken = null;
                }
            }
            finally
            {
                _gate.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await ReleaseAsync().ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        private async ValueTask ReleaseAsync()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            await _registration.DisposeAsync().ConfigureAwait(false);
            owned.Ado.CancellationToken = null;
            try
            {
                // Disposing the transaction rolls back; physical close also covers failed SQL/connection loss.
                IDbTransaction? transaction = owned.Ado.Transaction;
                owned.Ado.Transaction = null;
                transaction?.Dispose();
            }
            finally
            {
                owned.Dispose();
            }
        }
    }
}
