using System.Collections.Immutable;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationSourceCommandLineTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void Parse_SourceCaptureBindsProviderEnvironmentAndAbsoluteDumpBeforeReadingControl()
    {
        string dump = Path.GetFullPath("contract-test-dump");
        OfflineMigrationSourceCommandOptions options = OfflineMigrationCommandLine.ParseSourceObservation(
            ["observe-source", "--provider", "postgresql", "--env-file", "source.env", "--timeout-seconds", "30", "--capture-session", "--dump-output", dump]);
        Assert.Equal(CurrentSchemaProviderKind.PostgreSql, options.Provider);
        Assert.Equal("source.env", options.EnvironmentFilePath);
        Assert.True(options.CaptureSession);
        Assert.Equal(dump, options.DumpOutputPath);
        Assert.Equal(30, options.TimeoutSeconds);
    }

    [Theory]
    [InlineData("--snapshot-id")]
    [InlineData("--source-json")]
    [InlineData("--dump-sha256")]
    [InlineData("--release-manifest")]
    public void Parse_CallerCannotSupplySourceSnapshotOrHash(string argument)
    {
        Assert.StartsWith("schema_source_observation_argument_unknown:", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParseSourceObservation(["observe-source", "--provider", "postgresql", "--env-file", "source.env", "--timeout-seconds", "30", argument, "value"])).Message);
    }

    [Theory]
    [InlineData("mysql")]
    [InlineData("sqlite")]
    public void Parse_CaptureRejectsProvidersWithoutNativeExportCapability(string provider)
    {
        Assert.Equal("schema_source_capture_provider_or_dump_path_invalid", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParseSourceObservation(["observe-source", "--provider", provider,
                "--env-file", "source.env", "--timeout-seconds", "30", "--capture-session", "--dump-output", Path.GetFullPath("contract-test-dump")])).Message);
    }

    [Fact]
    public void Parse_RejectsRelativeDumpPathDuplicateCaptureAndDumpWithoutCapture()
    {
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseSourceObservation(
            ["observe-source", "--provider", "postgresql", "--env-file", "source.env", "--timeout-seconds", "30", "--capture-session", "--dump-output", "relative.dump"]));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseSourceObservation(
            ["observe-source", "--provider", "postgresql", "--env-file", "source.env", "--timeout-seconds", "30", "--capture-session", "--capture-session"]));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationCommandLine.ParseSourceObservation(
            ["observe-source", "--provider", "postgresql", "--env-file", "source.env", "--timeout-seconds", "30", "--dump-output", Path.GetFullPath("contract-test-dump")]));
    }

    [Fact]
    public async Task Observe_WithoutCaptureEmitsOnlyObservedSource()
    {
        var observer = new ContractObserver();
        using var output = new StringWriter();
        using var control = new StringReader(string.Empty);
        await OfflineMigrationHost.ObserveSourceAsync(new(CurrentSchemaProviderKind.PostgreSql, "source.env", false, null, 30),
            "contract-only-connection", observer, control, output, CancellationToken.None);
        using JsonDocument source = JsonDocument.Parse(output.ToString());
        Assert.Equal(Digest, source.RootElement.GetProperty("ContentDigest").GetString());
        Assert.False(source.RootElement.TryGetProperty("status", out _));
        Assert.Equal(0, observer.CaptureCalls);
    }

    [Fact]
    public async Task Capture_WaitsForClosedHandshakeAndActualObserverTerminalBeforeFinalEvidence()
    {
        var observer = new ContractObserver();
        using var control = new ControlledReader();
        using var output = new StringWriter();
        string dump = Path.GetFullPath($"contract-dump-{Guid.NewGuid():N}");
        Task operation = OfflineMigrationHost.ObserveSourceAsync(new(CurrentSchemaProviderKind.PostgreSql, "source.env", true, dump, 30),
            "contract-only-connection", observer, control, output, CancellationToken.None);
        try
        {
            await control.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(operation.IsCompleted);
            Assert.DoesNotContain("\"status\":\"ok\"", output.ToString());
            control.Release("DUMP_COMPLETED");
            await observer.DumpHandshake.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(dump, observer.DumpPath);
            Assert.False(operation.IsCompleted);
            Assert.DoesNotContain("\"status\":\"ok\"", output.ToString());
            observer.Terminal.TrySetResult();
            await operation;
            string[] lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
            Assert.Equal(2, lines.Length);
            using JsonDocument first = JsonDocument.Parse(lines[0]);
            using JsonDocument final = JsonDocument.Parse(lines[1]);
            Assert.Equal("ok", final.RootElement.GetProperty("status").GetString());
            JsonElement evidence = final.RootElement.GetProperty("capture");
            Assert.Equal(first.RootElement.GetProperty("Source").GetRawText(), evidence.GetProperty("Source").GetRawText());
            Assert.Equal(first.RootElement.GetProperty("SnapshotId").GetString(), evidence.GetProperty("SnapshotId").GetString());
            Assert.Equal(first.RootElement.GetProperty("CapturedAt").GetString(), evidence.GetProperty("CapturedAt").GetString());
            Assert.Equal(ContractObserver.s_snapshotTime, evidence.GetProperty("CapturedAt").GetDateTimeOffset());
            Assert.Equal(30, evidence.GetProperty("TimeoutSeconds").GetInt32());
            Assert.Equal(Digest, evidence.GetProperty("DatabaseDumpSha256").GetString());
        }
        finally
        {
            control.Release("DUMP_COMPLETED");
            observer.Terminal.TrySetResult();
            await operation;
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("RELEASE")]
    [InlineData("DUMP_COMPLETED another-path")]
    [InlineData("dump_completed")]
    public async Task Capture_EofUnknownControlAndPathInjectionNeverEmitCompletedEvidence(string? controlLine)
    {
        var observer = new ContractObserver();
        using var control = new StringReader(controlLine is null ? string.Empty : controlLine + "\n");
        using var output = new StringWriter();
        observer.Terminal.TrySetResult();
        Assert.Equal("schema_source_capture_dump_terminal_required", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.ObserveSourceAsync(new(CurrentSchemaProviderKind.PostgreSql, "source.env", true,
                Path.GetFullPath($"contract-dump-{Guid.NewGuid():N}"), 30), "contract-only-connection", observer, control, output, CancellationToken.None))).Message);
        Assert.DoesNotContain("\"status\":\"ok\"", output.ToString());
        Assert.True(observer.ScopeClosed);
    }

    [Fact]
    public async Task Capture_CancellationDrainsObserverScopeWithoutFinalEvidence()
    {
        using var cancellation = new CancellationTokenSource();
        var observer = new ContractObserver();
        using var control = new ControlledReader();
        using var output = new StringWriter();
        Task operation = OfflineMigrationHost.ObserveSourceAsync(new(CurrentSchemaProviderKind.PostgreSql, "source.env", true,
            Path.GetFullPath($"contract-dump-{Guid.NewGuid():N}"), 30), "contract-only-connection", observer, control, output, cancellation.Token);
        try
        {
            await control.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
            Assert.True(observer.ScopeClosed);
            Assert.DoesNotContain("\"status\":\"ok\"", output.ToString());
        }
        finally
        {
            cancellation.Cancel();
            control.Release(null);
            observer.Terminal.TrySetResult();
            try
            {
                await operation;
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
            }
        }
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("+1")]
    [InlineData("01")]
    [InlineData(" 1")]
    [InlineData("1 ")]
    [InlineData("1.0")]
    [InlineData("1e2")]
    [InlineData("2147484")]
    [InlineData("99999999")]
    public void Parse_RejectsNonCanonicalOrUnrepresentableTimeout(string timeout)
    {
        Assert.Equal("schema_source_observation_timeout_invalid", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParseSourceObservation(["observe-source", "--provider", "postgresql",
                "--env-file", "source.env", "--timeout-seconds", timeout])).Message);
    }

    [Fact]
    public void Parse_RequiresExplicitTimeoutAndAcceptsRepresentationBoundary()
    {
        Assert.Equal("schema_source_observation_timeout_required", Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationCommandLine.ParseSourceObservation(["observe-source", "--provider", "postgresql",
                "--env-file", "source.env"])).Message);
        Assert.Equal(2147483, OfflineMigrationCommandLine.ParseSourceObservation(["observe-source", "--provider",
            "postgresql", "--env-file", "source.env", "--timeout-seconds", "2147483"]).TimeoutSeconds);
    }

    [Fact]
    public async Task Observe_InvalidBudgetRefusesBeforeEnvironmentOrCapabilityConstruction()
    {
        int reads = 0;
        int capabilities = 0;
        using var control = new StringReader(string.Empty);
        using var output = new StringWriter();
        Assert.Equal("schema_source_observation_timeout_invalid", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationHost.ObserveSourceWithinBudgetAsync(new(CurrentSchemaProviderKind.PostgreSql, "source.env", false, null, 0),
                _ => { reads++; return Task.FromResult("contract-only"); },
                () => { capabilities++; return new ContractObserver(); }, control, output, CancellationToken.None))).Message);
        Assert.Equal(0, reads);
        Assert.Equal(0, capabilities);
        Assert.Equal(string.Empty, output.ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Observe_ActualOwnedDeadlineCancelsEnvironmentOrCaptureAndAwaitsScope(bool inCapture)
    {
        var clock = new DeadlineTimeProvider();
        var observer = new ContractObserver();
        using var control = new ControlledReader();
        using var output = new StringWriter();
        var environmentEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var environmentRelease = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        bool environmentClosed = false;
        Task operation = OfflineMigrationHost.ObserveSourceWithinBudgetAsync(
            new(CurrentSchemaProviderKind.PostgreSql, "source.env", inCapture,
                inCapture ? Path.GetFullPath($"contract-dump-{Guid.NewGuid():N}") : null, 30), async token =>
            {
                environmentEntered.TrySetResult();
                try
                {
                    return inCapture ? "contract-only" : await environmentRelease.Task.WaitAsync(token);
                }
                finally
                {
                    environmentClosed = true;
                }
            }, () => observer, control, output, CancellationToken.None, clock);
        try
        {
            await (inCapture ? control.Entered.Task : environmentEntered.Task).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(TimeSpan.FromSeconds(30), clock.DueTime);
            Assert.False(operation.IsCompleted);
            clock.Fire();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
            Assert.True(environmentClosed);
            Assert.Equal(inCapture, observer.ScopeClosed);
            Assert.DoesNotContain("\"status\":\"ok\"", output.ToString());
        }
        finally
        {
            clock.Fire();
            environmentRelease.TrySetResult("contract-only");
            control.Release(null);
            observer.Terminal.TrySetResult();
            try
            {
                await operation;
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    // Fires the real CancellationTokenSource timer callback without wall-clock sleeps.
    private sealed class DeadlineTimeProvider : TimeProvider
    {
        private DeadlineTimer? _timer;
        internal TimeSpan DueTime
        {
            get; private set;
        }
        internal void Fire() => _timer?.Fire();

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            DueTime = dueTime;
            return _timer = new DeadlineTimer(callback, state);
        }

        private sealed class DeadlineTimer(TimerCallback callback, object? state) : ITimer
        {
            private bool _disposed;
            internal void Fire()
            {
                if (!_disposed)
                {
                    callback(state);
                }
            }

            public bool Change(TimeSpan dueTime, TimeSpan period) => !_disposed;
            public void Dispose() => _disposed = true;
            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    // A pure stdio protocol fixture. It is not a native transaction, dump, or backup proof.
    private sealed class ContractObserver : IOfflineMigrationSnapshotSourceObserver
    {
        internal static readonly DateTimeOffset s_snapshotTime = new(2026, 10, 3, 0, 0, 0, TimeSpan.Zero);
        private static readonly OfflineMigrationSourceObservation s_source = new(
            new(CurrentSchemaProviderKind.PostgreSql, "contract-source", "contract-database"),
            "contract-observer", "v1", ImmutableArray<OfflineMigrationFact>.Empty,
            ImmutableArray<OfflineMigrationFact>.Empty, ImmutableArray<OfflineMigrationFact>.Empty, Digest);

        internal TaskCompletionSource DumpHandshake { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Terminal { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string? DumpPath
        {
            get; private set;
        }
        internal bool ScopeClosed
        {
            get; private set;
        }
        internal int CaptureCalls
        {
            get; private set;
        }

        public Task<OfflineMigrationSourceObservation> ObserveAsync(CurrentSchemaProviderKind provider,
            string connectionString, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(s_source);
        }

        public async Task<(OfflineMigrationSourceObservation Source, string SnapshotId, DateTimeOffset CapturedAt, string DumpSha256)> CapturePostgreSqlSnapshotAsync(
            string connectionString, Func<OfflineMigrationSourceObservation, string, DateTimeOffset, CancellationToken, Task<string>> awaitCompletedDumpPath,
            CancellationToken cancellationToken)
        {
            CaptureCalls++;
            try
            {
                DumpPath = await awaitCompletedDumpPath(s_source, "contract-snapshot", s_snapshotTime, cancellationToken);
                DumpHandshake.TrySetResult();
                await Terminal.Task.WaitAsync(cancellationToken);
                return (s_source, "contract-snapshot", s_snapshotTime, Digest);
            }
            finally
            {
                ScopeClosed = true;
            }
        }
    }

    private sealed class ControlledReader : StringReader
    {
        private readonly TaskCompletionSource<string?> _line = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal ControlledReader() : base(string.Empty)
        {
        }

        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal void Release(string? line) => _line.TrySetResult(line);

        public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
        {
            Entered.TrySetResult();
            return new(_line.Task.WaitAsync(cancellationToken));
        }
    }
}
