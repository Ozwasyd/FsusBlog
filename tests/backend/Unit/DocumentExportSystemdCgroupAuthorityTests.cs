using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSystemdCgroupAuthorityTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"fsusblog-document-export-authority-{Guid.NewGuid():N}");

    [Fact]
    public void ParsesExactSystemdPropertiesAndRejectsMissingUnknownOrDuplicateFields()
    {
        IReadOnlyDictionary<string, string> properties =
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nActiveState=active\nControlGroup=/unit\n",
                ["LoadState", "ActiveState", "ControlGroup"]);

        Assert.Equal("loaded", properties["LoadState"]);
        Assert.Equal("active", properties["ActiveState"]);
        Assert.Equal("/unit", properties["ControlGroup"]);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\n",
                ["LoadState", "ActiveState"]));
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nUnknown=value\n",
                ["LoadState"]));
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nLoadState=loaded\n",
                ["LoadState"]));
    }

    [Fact]
    public void ParsesCgroupCountersWithoutSynthesizingMissingMalformedOrDuplicateValues()
    {
        Directory.CreateDirectory(_root);
        string path = Path.Combine(_root, "cpu.stat");
        File.WriteAllText(path, "usage_usec 42000\nuser_usec 31000\nsystem_usec 11000\n", Encoding.ASCII);

        IReadOnlyDictionary<string, long> counters =
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path);

        Assert.Equal(42000, counters["usage_usec"]);
        Assert.Equal(31000, counters["user_usec"]);
        Assert.Equal(11000, counters["system_usec"]);
        File.WriteAllText(path, "usage_usec -1\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
        File.WriteAllText(path, "usage_usec 1\nusage_usec 2\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
        File.WriteAllText(path, "usage_usec\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
    }

    [Fact]
    public void RejectsMissingOrNonBinaryCgroupPopulationState()
    {
        Assert.False(DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 0
            }));
        Assert.True(DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 1
            }));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 2
            }));
    }

    [Fact]
    public void ParsesRealSystemctlDurationFormatAndRejectsNonCanonicalValues()
    {
        Assert.Equal(
            20_000_000,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("20s", "RuntimeMaxUSec"));
        Assert.Equal(
            90_000_000,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("1min 30s", "RuntimeMaxUSec"));
        Assert.Equal(
            1_001,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("1ms 1us", "RuntimeMaxUSec"));

        foreach (string invalid in new[]
        {
            "infinity",
            "-1s",
            "1fortnight",
            "1.0000001ms",
            "1s 1min",
            "1s 1s",
            "0s"
        })
        {
            Assert.Throws<InvalidDataException>(() =>
                DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds(
                    invalid,
                    "RuntimeMaxUSec"));
        }
    }

    [Fact]
    public void OnlyMissingCgroupPathsCanEnterTerminalSnapshotHandling()
    {
        Assert.True(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new FileNotFoundException()));
        Assert.True(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new DirectoryNotFoundException()));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new IOException("unqualified cgroup read")));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new UnauthorizedAccessException()));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new InvalidDataException("malformed cgroup counters")));
    }

    [Fact]
    public void RejectsFloatingAuthorityPathsInvalidDigestsAndUnboundedPolling()
    {
        DocumentExportSystemdCgroupAuthorityContract installed =
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract();

        Assert.Throws<InvalidDataException>(() => new DocumentExportSystemdCgroupAuthority(
            installed with
            {
                SystemdRunPath = "systemd-run"
            }));
        Assert.Throws<ArgumentException>(() => new DocumentExportSystemdCgroupAuthority(
            installed with
            {
                BubblewrapDigest = "latest"
            }));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new DocumentExportSystemdCgroupAuthority(installed, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new DocumentExportSystemdCgroupAuthority(installed, 1001));
    }

    [Fact]
    public async Task RejectsClosedWorkloadDriftBeforeAnyTransientServiceCanStart()
    {
        DocumentExportSystemdCgroupAuthority authority = new(
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract());
        Directory.CreateDirectory(_root);
        var workload = new ProcessStartInfo("/usr/bin/true")
        {
            WorkingDirectory = _root,
            UseShellExecute = false
        };
        workload.ArgumentList.Add("--version");

        await Assert.ThrowsAsync<InvalidDataException>(() => authority.StartAsync(
            new string('a', 32),
            workload,
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets,
            Path.Combine(_root, "stdout.log"),
            Path.Combine(_root, "stderr.log"),
            CancellationToken.None));
    }

    [Fact]
    public async Task RejectsDigestOrVersionDriftBeforeTheBusinessUnitAdmissionCall()
    {
        DocumentExportSystemdCgroupAuthorityContract installed =
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract();
        Directory.CreateDirectory(_root);
        ProcessStartInfo workload = ClosedBubblewrapProbe();
        DocumentExportResourceBudgets budgets =
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets;

        DocumentExportSystemdCgroupAuthority digestDrift = new(installed with
        {
            SystemdRunDigest = DocumentExportTestToolFixture.Digest("tampered-systemd-run")
        });
        await Assert.ThrowsAsync<InvalidDataException>(() => digestDrift.StartAsync(
            new string('b', 32),
            workload,
            budgets,
            Path.Combine(_root, "digest-stdout.log"),
            Path.Combine(_root, "digest-stderr.log"),
            CancellationToken.None));

        DocumentExportSystemdCgroupAuthority versionDrift = new(installed with
        {
            BubblewrapVersion = "bwrap unavailable-version"
        });
        await Assert.ThrowsAsync<InvalidDataException>(() => versionDrift.StartAsync(
            new string('c', 32),
            ClosedBubblewrapProbe(),
            budgets,
            Path.Combine(_root, "version-stdout.log"),
            Path.Combine(_root, "version-stderr.log"),
            CancellationToken.None));
    }

    [Fact]
    public void StaticContractUsesServicePreStartLimitsAndNeverMisstatesCpuQuotaAsTotalCpu()
    {
        string source = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "DocumentExportSystemdCgroupAuthority.cs");

        Assert.Contains("--service-type=exec", source, StringComparison.Ordinal);
        Assert.Contains("--no-block", source, StringComparison.Ordinal);
        Assert.Contains("MemoryMax=", source, StringComparison.Ordinal);
        Assert.Contains("MemorySwapMax=0", source, StringComparison.Ordinal);
        Assert.Contains("TasksMax=", source, StringComparison.Ordinal);
        Assert.Contains("RuntimeMaxSec=", source, StringComparison.Ordinal);
        Assert.Contains("KillMode=control-group", source, StringComparison.Ordinal);
        Assert.Contains("cgroup.kill", source, StringComparison.Ordinal);
        Assert.Contains("cgroup.events", source, StringComparison.Ordinal);
        Assert.Contains("usage_usec.sampled-kill", source, StringComparison.Ordinal);
        Assert.Equal(1, source.Split("Process.Start(", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("UseShellExecute = true", source, StringComparison.Ordinal);
        Assert.DoesNotContain("/bin/sh", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironment", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CPUQuota", source, StringComparison.Ordinal);
        Assert.DoesNotContain("cpu.max", source, StringComparison.Ordinal);
        Assert.DoesNotContain("--scope", source, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private ProcessStartInfo ClosedBubblewrapProbe()
    {
        var workload = new ProcessStartInfo("/usr/bin/bwrap")
        {
            WorkingDirectory = _root,
            UseShellExecute = false
        };
        workload.ArgumentList.Add("--version");
        return workload;
    }
}
