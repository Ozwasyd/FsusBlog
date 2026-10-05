using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportCgroupDrainTests
{
    [Theory]
    [InlineData(false, 0, true)]
    [InlineData(false, 1, false)]
    [InlineData(true, 0, false)]
    [InlineData(true, 1, false)]
    [InlineData(false, -1, false)]
    public void RequiresBothEmptyPopulationAndAnObservedZeroProcessCount(
        bool populated,
        int processes,
        bool expected)
    {
        DocumentExportCgroupObservation observation = CreateObservation(populated, processes);

        Assert.Equal(expected, DocumentExportSystemdCgroupAuthority.IsDrained(observation));
        Assert.Equal(processes, observation.PidsCurrent);
        Assert.Equal(populated, observation.Populated);
    }

    [Fact]
    public void InconsistentSnapshotRemainsUnqualifiedUntilAFreshDrainedObservation()
    {
        DocumentExportCgroupObservation draining = CreateObservation(false, 1);
        DocumentExportCgroupObservation drained = draining with
        {
            PidsCurrent = 0
        };

        Assert.False(DocumentExportSystemdCgroupAuthority.IsDrained(draining));
        Assert.True(DocumentExportSystemdCgroupAuthority.IsDrained(drained));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsDrained(drained with
        {
            Populated = true
        }));
        Assert.Equal(1, draining.PidsCurrent);
        Assert.Equal(draining.CpuUsageMicroseconds, drained.CpuUsageMicroseconds);
        Assert.Equal(draining.PidsPeak, drained.PidsPeak);
        Assert.Equal(draining.PidsMaxEvents, drained.PidsMaxEvents);
    }

    private static DocumentExportCgroupObservation CreateObservation(bool populated, int processes)
        => new(42_000, 1_024, 2_048, 0, 0, processes, 2, 0, populated);
}
