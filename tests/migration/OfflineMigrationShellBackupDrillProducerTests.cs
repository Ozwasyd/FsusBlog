using System.Text;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Original invocation adapter lifecycle fixtures using an explicitly fake shell body.
/// Actual child/pipe/argument behavior is exercised when these tests run; neither fake
/// stdout nor a successful child proves encryption, PostgreSQL or backup admission.
/// </summary>
public sealed class OfflineMigrationShellBackupDrillProducerTests
{
    [Fact]
    public async Task ActualInvocationUsesOriginalArgumentsFreshPathsAndRemainingDeadline()
    {
        using var fixture = new ShellFixture("printf '%s\\n' \"$*\" \"$FSUSBLOG_DRILL_OUTPUT_DIR\" \"$FSUSBLOG_DRILL_WORK_DIR\" \"$FSUSBLOG_DRILL_RUN_ID\" \"$FSUSBLOG_SITE_BACKUP_PACKAGE\" \"$FSUSBLOG_MIGRATION_SERVER_DLL\"\n");
        fixture.Clock.Seconds = 7;
        OfflineMigrationBackupDrillTerminal terminal = await fixture.RunAsync();
        fixture.TerminalObserved = true;
        string[] output = Encoding.UTF8.GetString(terminal.StandardOutput.Span).Split('\n');
        Assert.Equal(0, terminal.ExitCode);
        Assert.Equal("--migration-evidence --timeout-seconds 23", output[0]);
        Assert.Equal(fixture.OutputRoot, output[1]);
        Assert.Equal(Path.Combine(fixture.OutputRoot, "restore-work"), output[2]);
        Assert.Equal(fixture.Invocation, output[3]);
        Assert.Equal(fixture.Options.BackupPackagePath, output[4]);
        Assert.Equal(fixture.Configuration.MigrationAssembly, output[5]);
        Assert.Equal(terminal.StandardOutput.ToArray(), File.ReadAllBytes(fixture.OutputRoot + ".invocation.stdout"));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite,
            File.GetUnixFileMode(fixture.OutputRoot + ".invocation.stderr"));
    }

    [Fact]
    public async Task ActualNonzeroTerminalIsNotReplacedByAStatusFlag()
    {
        using var fixture = new ShellFixture("printf '{\"status\":\"ok\"}'\nprintf 'retained failure' >&2\nexit 7\n");
        OfflineMigrationBackupDrillTerminal terminal = await fixture.RunAsync();
        fixture.TerminalObserved = true;
        Assert.Equal(7, terminal.ExitCode);
        Assert.Equal("retained failure", File.ReadAllText(fixture.OutputRoot + ".invocation.stderr"));
    }

    [Fact]
    public async Task SimultaneousRealPipesAreDrainedBeforeReturning()
    {
        using var fixture = new ShellFixture("for ((i=0; i<4096; i++)); do printf 'stdout-abcdefgh\\n'; printf 'stderr-abcdefgh\\n' >&2; done\n");
        OfflineMigrationBackupDrillTerminal terminal = await fixture.RunAsync();
        fixture.TerminalObserved = true;
        Assert.Equal(0, terminal.ExitCode);
        Assert.Equal(4096, Encoding.UTF8.GetString(terminal.StandardOutput.Span).Count(character => character == '\n'));
        Assert.Equal(4096, File.ReadAllText(fixture.OutputRoot + ".invocation.stderr").Count(character => character == '\n'));
    }

    [Fact]
    public async Task OriginalDeadlineMustExistBeforeFilesOrProcessAreCreated()
    {
        using var fixture = new ShellFixture("exit 0\n");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.RunAsync(fixture.Options with { OperationDeadline = null }));
        Assert.Equal("offline_backup_shell_original_operation_deadline_required", error.Message);
        fixture.AssertNotStarted();
    }

    [Fact]
    public async Task AlreadySpentOriginalBudgetDoesNotRestartTheTotalAtInvocation()
    {
        using var fixture = new ShellFixture("exit 0\n");
        fixture.Clock.Seconds = 30;
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RunAsync());
        fixture.AssertNotStarted();
    }

    [Fact]
    public async Task CancellationBeforeInvocationCreatesNoOutput()
    {
        using var fixture = new ShellFixture("exit 0\n");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.RunAsync(token: cancellation.Token));
        fixture.AssertNotStarted();
    }

    [Fact]
    public async Task CancellationWaitsForActualOwnedShellTerminalAndRetainsRawFailure()
    {
        using var fixture = new ShellFixture("trap 'printf terminal >&2; exit 143' TERM\nprintf ready >\"$FSUSBLOG_DRILL_OUTPUT_DIR.ready\"\nwhile :; do sleep 0.05; done\n");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<OfflineMigrationBackupDrillTerminal> pending = fixture.RunAsync(token: cancellation.Token);
        try
        {
            while (!File.Exists(fixture.OutputRoot + ".ready"))
            {
                await Task.Delay(10, cancellation.Token);
            }
            cancellation.Cancel();
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => pending);
            Assert.Equal("offline_backup_shell_invocation_failed_or_cancelled", error.Message);
            fixture.TerminalObserved = true;
            Assert.Contains("terminal", File.ReadAllText(fixture.OutputRoot + ".invocation.stderr"));
        }
        finally
        {
            cancellation.Cancel();
            try { await pending; }
            catch (InvalidOperationException) { }
        }
    }

    [Theory]
    [InlineData("FSUSBLOG_DRILL_MODE")]
    [InlineData("FSUSBLOG_SITE_BACKUP_PACKAGE")]
    [InlineData("DOTNET_BIN")]
    [InlineData("BASH_ENV")]
    [InlineData("BASH_FUNC_override%%")]
    public async Task AmbientOrInjectedShellAuthorityCannotOverrideOriginalInvocation(string name)
    {
        using var fixture = new ShellFixture("exit 0\n");
        var environment = new Dictionary<string, string>(fixture.Configuration.ExecutionEnvironment)
        {
            [name] = "caller-value"
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RunAsync(configuration:
            fixture.Configuration with { ExecutionEnvironment = environment }));
        fixture.AssertNotStarted();
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 0)]
    [InlineData(-1, 1)]
    [InlineData(2147484, 1)]
    public async Task FailureCleanupSelectionIsExplicitFiniteAndRepresentable(int terminate, int reap)
    {
        using var fixture = new ShellFixture("exit 0\n");
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RunAsync(configuration:
            fixture.Configuration with { TerminateGraceSeconds = terminate, KillReapSeconds = reap }));
        fixture.AssertNotStarted();
    }

    [Fact]
    public async Task ExistingOutputRootCannotBecomeANewInvocation()
    {
        using var fixture = new ShellFixture("exit 0\n");
        Directory.CreateDirectory(fixture.OutputRoot);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RunAsync());
        fixture.AssertNotStarted();
    }

    [Fact]
    public async Task MissingIdentityCannotStartAProducerOrPublishEvidence()
    {
        using var fixture = new ShellFixture("exit 0\n");
        File.Delete(fixture.Configuration.IdentityFile);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RunAsync());
        fixture.AssertNotStarted();
    }

    private sealed class FixtureClock : TimeProvider
    {
        internal long Seconds { get; set; }
        public override long TimestampFrequency => 1;
        public override long GetTimestamp() => Seconds;
    }

    private sealed class ShellFixture : IDisposable
    {
        internal string Parent { get; } = Path.Combine(Path.GetTempPath(), "fsusblog-backup-shell-" + Guid.NewGuid().ToString("N"));
        internal string Invocation { get; } = Guid.NewGuid().ToString("N");
        internal string OutputRoot => Path.Combine(Parent, "new-output");
        internal FixtureClock Clock { get; } = new();
        internal OfflineMigrationPlanCommandOptions Options { get; }
        internal OfflineMigrationShellBackupDrillConfiguration Configuration { get; }
        internal bool TerminalObserved { get; set; }

        internal ShellFixture(string fakeBody)
        {
            Directory.CreateDirectory(Parent, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            string repository = Path.Combine(Parent, "repository");
            string scripts = Path.Combine(repository, "tools/operations");
            Directory.CreateDirectory(scripts);
            File.WriteAllText(Path.Combine(scripts, "backup-restore-drill.sh"), "#!/usr/bin/env bash\nset -euo pipefail\n" + fakeBody);
            string package = Path.Combine(Parent, "package");
            string identity = Path.Combine(Parent, "identity");
            string assembly = Path.Combine(Parent, "migration.dll");
            foreach (string path in new[] { package, identity, assembly }) File.WriteAllText(path, "fixture-not-authenticated");
            Configuration = new(repository, "/usr/bin/bash", "/usr/bin/setsid", "/usr/bin/bash", assembly,
                identity, null, new Dictionary<string, string> { ["PATH"] = "/usr/bin" }, 2, 2);
            Options = new(new(CurrentSchemaProviderKind.PostgreSql, "fixture-instance", "fixture-database"),
                Path.Combine(Parent, "source.env"), package, Path.Combine(OutputRoot, "package-manifest.json"),
                Path.Combine(OutputRoot, "backup-restore-drill.json"), Path.Combine(Parent, "restore.env"),
                Path.Combine(Parent, "plan.json"), 30)
            {
                OperationDeadline = new(Clock, 30)
            };
        }

        internal Task<OfflineMigrationBackupDrillTerminal> RunAsync(OfflineMigrationPlanCommandOptions? options = null,
            OfflineMigrationShellBackupDrillConfiguration? configuration = null, CancellationToken token = default)
            => new OfflineMigrationShellBackupDrillProducer(configuration ?? Configuration)
                .RunAsync(options ?? Options, OutputRoot, Invocation, token);

        internal void AssertNotStarted()
        {
            Assert.False(File.Exists(OutputRoot + ".invocation.stdout"));
            Assert.False(File.Exists(OutputRoot + ".invocation.stderr"));
            TerminalObserved = true;
        }

        public void Dispose()
        {
            // Failed/unverified child ownership retains this exact fixture root, never a
            // broad sweep or deletion while an unknown child may still use its resources.
            if (TerminalObserved) Directory.Delete(Parent, recursive: true);
        }
    }
}
