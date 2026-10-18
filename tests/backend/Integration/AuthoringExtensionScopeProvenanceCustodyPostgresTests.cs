using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Npgsql;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionScopeProvenanceCustodyPostgresTests(PostgresSchemaMigrationFixture postgres)
{
    [Fact]
    public async Task QueuedTruncate_DoesNotMakeProvenanceVerifyOpenAnotherStateReader()
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        IAuthoringExtensionStateObservation state = await host.ObserveAsync(registration.Scope);
        IAuthoringExtensionApprovalScope provenance = await host.Authority.AcquireWithStateCustodyAsync(host.Context,
            AuthoringApprovalOperation.Deletion, registration.Scope, null, state, default);
        Task truncate = host.SqlAsync("TRUNCATE authoring_extension_state_scope CASCADE");
        try
        {
            await AuthoringExtensionScopeProvenanceActivationPostgresTests.WaitForQueryLockAsync(host.DataSource, "TRUNCATE authoring_extension_state_scope%");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await provenance.VerifyCurrentAsync(timeout.Token);
            await provenance.DisposeAsync();
            await state.VerifyCurrentAsync(timeout.Token);
            Assert.False(truncate.IsCompleted);
        }
        finally
        {
            await provenance.DisposeAsync();
            await state.DisposeAsync();
        }
        await truncate;
        await host.RefuseAsync(registration.Scope);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealDeleteWriter_StateThenProvenance_HasNoOpposingMeasureWaitEdge(bool writerFirst)
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        IAuthoringExtensionStateObservation? state = null;
        IAuthoringExtensionApprovalScope? provenance = null;
        if (!writerFirst)
        {
            state = await host.ObserveAsync(registration.Scope);
            provenance = await host.Authority.AcquireWithStateCustodyAsync(host.Context,
                AuthoringApprovalOperation.Deletion, registration.Scope, null, state, default);
        }
        await using NpgsqlConnection writer = await host.DataSource.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await writer.BeginTransactionAsync();
        await using var key = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended($1,2143))", writer);
        key.Parameters.AddWithValue($"authoring-extension-state:{ScopeId(registration.Scope)}");
        Task takeKey = key.ExecuteNonQueryAsync();
        try
        {
            if (writerFirst)
            {
                await takeKey;
                Task<IAuthoringExtensionStateObservation> acquire = host.ObserveAsync(registration.Scope).AsTask();
                await host.WaitForBlockedWriterAsync();
                await DeleteAsync(writer, registration.Scope);
                await transaction.CommitAsync();
                await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => acquire);
            }
            else
            {
                await host.WaitForBlockedWriterAsync();
                Assert.False(takeKey.IsCompleted);
                await provenance!.VerifyCurrentAsync(default);
                await provenance.DisposeAsync();
                await state!.VerifyCurrentAsync(default);
                Assert.False(takeKey.IsCompleted);
                await state.DisposeAsync();
                await takeKey.WaitAsync(TimeSpan.FromSeconds(3));
                await DeleteAsync(writer, registration.Scope);
                await transaction.CommitAsync();
            }
        }
        finally
        {
            if (provenance is not null)
            {
                await provenance.DisposeAsync();
            }
            if (state is not null)
            {
                await state.DisposeAsync();
            }
        }
        await host.RefuseAsync(registration.Scope);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    [InlineData("reversed")]
    [InlineData("default")]
    public async Task ExactSortedCompleteStateKeys_RefuseAlteredDiagnosticsWithoutDisposingRealBorrowedOwner(string change)
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration source = await host.BeginAsync();
        await host.CompleteAsync(source);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        AuthoringExtensionScopeRegistration destination = await host.Issuer.BeginAsync(host.Context, next, source.Scope);
        await host.Issuer.CompleteAsync(host.Context, next, destination.RegistrationId);
        await using IAuthoringExtensionStateObservation state = await host.ObserveAsync(source.Scope, destination.Scope);
        ImmutableArray<string> ids = change switch
        {
            "missing" => [state.AcquiredScopeIds[0]],
            "extra" => [.. state.AcquiredScopeIds, new string('f', 64)],
            "duplicate" => [.. state.AcquiredScopeIds, state.AcquiredScopeIds[0]],
            "reversed" => [.. state.AcquiredScopeIds.Reverse()],
            _ => default
        };
        var changed = new ChangedIds(state, ids);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireWithStateCustodyAsync(host.Context,
            AuthoringApprovalOperation.Migration, source.Scope, destination.Scope, changed, default).AsTask());
        await state.VerifyCurrentAsync(default);
        Assert.False(changed.Disposed);
    }

    [Fact]
    public async Task BorrowedStateReleased_RejectsCurrentnessAndLegacyEntryNeverFallsBack()
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration source = await host.BeginAsync();
        await host.CompleteAsync(source);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireAsync(host.Context,
            AuthoringApprovalOperation.Deletion, source.Scope, null, default).AsTask());
        IAuthoringExtensionStateObservation state = await host.ObserveAsync(source.Scope);
        await using IAuthoringExtensionApprovalScope held = await host.Authority.AcquireWithStateCustodyAsync(host.Context,
            AuthoringApprovalOperation.Deletion, source.Scope, null, state, default);
        await state.DisposeAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => held.VerifyCurrentAsync(default).AsTask());
    }

    [Fact]
    public async Task OriginalPackageWitness_MustMatchThePersistedProvenancePackage()
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration source = await host.BeginAsync();
        await host.CompleteAsync(source);
        await using IAuthoringExtensionStateObservation state = await host.ObserveAsync(source.Scope);
        await host.SqlAsync("UPDATE authoring_extension_scope_provenance SET package_identity=$1 WHERE registration_id=$2",
            new string('c', 64), source.RegistrationId);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireWithStateCustodyAsync(host.Context,
            AuthoringApprovalOperation.Deletion, source.Scope, null, state, default).AsTask());
        await state.VerifyCurrentAsync(default);
    }

    private static async Task DeleteAsync(NpgsqlConnection connection, AuthoringStateScope scope)
    {
        await using var command = new NpgsqlCommand("DELETE FROM authoring_extension_state_scope WHERE scope_id=$1", connection);
        command.Parameters.AddWithValue(ScopeId(scope));
        Assert.Equal(1, await command.ExecuteNonQueryAsync());
    }

    private sealed class ChangedIds(IAuthoringExtensionStateObservation original, ImmutableArray<string> ids)
        : IAuthoringExtensionStateObservation
    {
        public bool Disposed
        {
            get; private set;
        }
        public AuthoringStateObservation State => original.State;
        public ImmutableArray<string> AcquiredScopeIds => ids;
        public ValueTask VerifyCurrentAsync(CancellationToken token) => original.VerifyCurrentAsync(token);
        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
