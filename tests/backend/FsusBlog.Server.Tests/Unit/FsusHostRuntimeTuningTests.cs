using FsusBlog.Server.Infrastructure.Bootstrap;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FsusHostRuntimeTuningTests
{
    [Fact]
    public void Apply_WithNoRuntimeTuningConfiguration_DoesNotForceAggressiveDefaults()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();

        FsusHostRuntimeTuningReport report = FsusHostRuntimeTuning.Apply(configuration);

        Assert.Null(report.ReadyToRun);
        Assert.Null(report.QuickJitForLoops);
        Assert.Null(report.TieredPgo);
        Assert.False(report.ReadyToRunApplied);
        Assert.False(report.QuickJitForLoopsApplied);
        Assert.False(report.TieredPgoApplied);
        Assert.False(report.ThreadPoolApplied);
        Assert.Equal(report.BeforeWorkerThreads, report.AfterWorkerThreads);
        Assert.Equal(report.BeforeCompletionPortThreads, report.AfterCompletionPortThreads);
    }
}
