using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Constructor/refusal fixtures only. No fake planning reader can construct the
// private actual backup invocation capability or prove package/native qualification.
public sealed class OfflineMigrationRetainedEvidenceAuthorityTests
{
    [Fact]
    public void MissingPlanningReaderIsRefusedBeforeOperationInputs()
    {
        Assert.Throws<ArgumentNullException>(() => new OfflineMigrationRetainedEvidenceAuthority(null!, Configuration()));
    }

    [Fact]
    public void MissingBackupConfigurationIsRefusedBeforePlanningRead()
    {
        var planning = new RefusingPlanning();
        Assert.Throws<ArgumentNullException>(() => new OfflineMigrationRetainedEvidenceAuthority(planning, null!));
        Assert.Equal(0, planning.Calls);
    }

    [Fact]
    public void RawShellFixtureConfigurationIsNotProductionRetention()
    {
        var planning = new RefusingPlanning();
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            new OfflineMigrationRetainedEvidenceAuthority(planning, Configuration()));
        Assert.Equal("offline_backup_owned_tool_configuration_required", failure.Message);
        Assert.Equal(0, planning.Calls);
    }

    [Fact]
    public void CompositionDoesNotExposePlanJsonOrBackupRecordImport()
    {
        Type type = typeof(OfflineMigrationRetainedEvidenceAuthority);
        Assert.Empty(type.GetConstructors());
        Assert.DoesNotContain(type.GetMethods(), method => method.Name is "FromPlan" or "Import" or "FromObservation");
        Assert.Empty(typeof(OfflineMigrationRetainedOwnedBackup).GetConstructors());
    }

    private static OfflineMigrationShellBackupDrillConfiguration Configuration()
        => new("/unused/repository", "/unused/bash", "/unused/setsid", "/unused/dotnet", "/unused/migration.dll",
            "/unused/identity", null, new Dictionary<string, string>(), 1, 1);

    private sealed class RefusingPlanning : IOfflineMigrationPlanningAuthorityReader
    {
        internal int Calls { get; private set; }

        public Task<OfflineMigrationPlanningAuthority> ReadAsync(CurrentSchemaProviderKind provider,
            CancellationToken cancellationToken)
        {
            Calls++;
            throw new InvalidOperationException("fixture_unobserved_planning_authority");
        }
    }
}
