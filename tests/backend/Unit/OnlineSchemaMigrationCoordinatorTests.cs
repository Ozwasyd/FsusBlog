using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationCoordinatorTests
{
    [Fact]
    public async Task ExecuteAsync_FailsClosedWithoutControlPlaneWrites()
    {
        var stateStore = new RecordingStateStore();
        var coordinator = new OnlineSchemaMigrationCoordinator(
            stateStore,
            NullLogger<OnlineSchemaMigrationCoordinator>.Instance);

        OnlineSchemaMigrationExecutionResult result = await coordinator.ExecuteAsync(
            OnlineSchemaMigrationPhase.Expand,
            migrationId: "20260720-post-comment-mutation-outbox",
            releaseId: "20260720000000-aaaaaaaaaaaa",
            contractEvidence: null,
            dryRun: false,
            cancellationToken: CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("schema_server_runtime_control_plane_removed", Assert.Single(result.Codes));
        Assert.False(stateStore.EnsureControlTablesCalled);
        Assert.Empty(stateStore.AppliedMigrationIds);
        Assert.Empty(stateStore.BackfillWrites);
    }

    [Fact]
    public async Task CheckAsync_DoesNotInferCurrentSchemaFromCatalog()
    {
        var coordinator = new OnlineSchemaMigrationCoordinator(
            new RecordingStateStore(),
            NullLogger<OnlineSchemaMigrationCoordinator>.Instance);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            coordinator.CheckAsync("20260720000000-aaaaaaaaaaaa", CancellationToken.None));

        Assert.Equal("schema_server_runtime_current_schema_not_from_catalog", error.Message);
    }

    private sealed class RecordingStateStore : IOnlineSchemaMigrationStateStore
    {
        public bool EnsureControlTablesCalled
        {
            get; private set;
        }

        public List<OnlineSchemaBackfillSnapshot> BackfillWrites { get; } = [];

        public List<string> AppliedMigrationIds { get; } = [];

        public Task<OnlineSchemaDatabaseSnapshot> ReadAsync(CancellationToken cancellationToken)
            => Task.FromResult(new OnlineSchemaDatabaseSnapshot(false, null, [], new Dictionary<string, OnlineSchemaBackfillSnapshot>()));

        public Task EnsureControlTablesAsync(CancellationToken cancellationToken)
        {
            EnsureControlTablesCalled = true;
            return Task.CompletedTask;
        }

        public Task SaveBackfillAsync(OnlineSchemaBackfillSnapshot value, CancellationToken cancellationToken)
        {
            BackfillWrites.Add(value);
            return Task.CompletedTask;
        }

        public Task MarkMigrationAppliedAsync(
            string migrationId,
            string checksum,
            ReleaseId releaseId,
            CancellationToken cancellationToken)
        {
            AppliedMigrationIds.Add(migrationId);
            return Task.CompletedTask;
        }

        public Task MarkSchemaCompatibilityCoordinateAsync(
            SchemaCompatibilityCoordinate coordinate,
            CancellationToken cancellationToken)
            => Task.CompletedTask;
    }
}
