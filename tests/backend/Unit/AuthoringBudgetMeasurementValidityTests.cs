using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringBudgetMeasurementValidityTests
{
    private static readonly AuthoringResourceMeasurement s_baseline = new(
        TimeSpan.FromMilliseconds(10), 100, 100, 100, 1, 100, 100, 100);

    [Theory]
    [InlineData("cpu")]
    [InlineData("memory")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("restart")]
    [InlineData("network")]
    [InlineData("file")]
    [InlineData("state")]
    public async Task ExecuteAsync_NegativeBaseline_FailsClosedBeforeOperation(string dimension)
    {
        var source = new MeasurementSource(WithValue(s_baseline, dimension, -1), s_baseline);
        var fixture = new Fixture(source);
        var operation = new Operation();

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation);

        Assert.Equal(0, operation.CallCount);
        Assert.Equal(1, source.CallCount);
        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData("cpu")]
    [InlineData("memory")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("restart")]
    [InlineData("network")]
    [InlineData("file")]
    [InlineData("state")]
    public async Task ExecuteAsync_NegativeFinalMeasurement_DiscardsReturnedValue(string dimension)
    {
        var source = new MeasurementSource(s_baseline, WithValue(s_baseline, dimension, -1));
        var fixture = new Fixture(source);
        var operation = new Operation();

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation);

        Assert.Equal(1, operation.CallCount);
        Assert.True(source.CallCount >= 2);
        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData("cpu")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("restart")]
    [InlineData("network")]
    [InlineData("file")]
    public async Task ExecuteAsync_FinalCounterRollback_FailsClosed(string dimension)
    {
        var fixture = new Fixture(new MeasurementSource(s_baseline, WithValue(s_baseline, dimension, 0)));
        var operation = new Operation();

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation);

        Assert.Equal(1, operation.CallCount);
        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData("cpu", -1)]
    [InlineData("memory", -1)]
    [InlineData("inbound", -1)]
    [InlineData("outbound", -1)]
    [InlineData("restart", -1)]
    [InlineData("network", -1)]
    [InlineData("file", -1)]
    [InlineData("state", -1)]
    [InlineData("cpu", 0)]
    [InlineData("inbound", 0)]
    [InlineData("outbound", 0)]
    [InlineData("restart", 0)]
    [InlineData("network", 0)]
    [InlineData("file", 0)]
    public async Task ExecuteAsync_InvalidLiveMeasurement_CancelsEvenWhenFinalMeasurementRecovers(
        string dimension,
        long value)
    {
        var source = new MeasurementSource(s_baseline, s_baseline,
            WithValue(s_baseline, dimension, value));
        var fixture = new Fixture(source);
        var operation = new Operation(waitForCancellation: true);

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation);

        Assert.Equal(1, operation.CallCount);
        Assert.True(operation.CancellationObserved);
        Assert.True(source.CallCount >= 3);
        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_ValidCountersAndDecreasingGauges_ReturnsValue(bool advanceCounters)
    {
        AuthoringResourceMeasurement after = advanceCounters
            ? new(TimeSpan.FromMilliseconds(11), 0, 101, 101, 2, 101, 101, 0)
            : s_baseline with
            {
                MemoryBytes = 0,
                StateBytes = 0
            };
        var fixture = new Fixture(new MeasurementSource(s_baseline, after));

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(new Operation());

        Assert.Equal(AuthoringBudgetStatus.Completed, result.Status);
        Assert.Equal("completed", result.StableReason);
        Assert.Equal("must-not-escape-on-invalid-measurement", result.Value);
        Assert.Equal(0, result.Telemetry.PeakMemoryBytes);
        Assert.Equal(0, result.Telemetry.StateBytes);
        Assert.Same(result.Telemetry, Assert.Single(fixture.Telemetry));
        Assert.Empty(fixture.Reasons);
        Assert.Equal(0, fixture.ProbeCount);
    }

    [Theory]
    [InlineData("cpu")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("network")]
    [InlineData("file")]
    public async Task ExecuteAsync_MinimumCounterValue_FailsClosedWithoutSubtractionOverflow(string dimension)
    {
        var fixture = new Fixture(new MeasurementSource(s_baseline,
            WithValue(s_baseline, dimension, long.MinValue)));

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(new Operation());

        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData("cpu")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("restart")]
    [InlineData("network")]
    [InlineData("file")]
    public async Task ExecuteAsync_LiveCounterRollbackAtOrAboveBaseline_CancelsOperation(string dimension)
    {
        long elevatedValue = dimension == "cpu" ? 200_000 : dimension == "restart" ? 2 : 200;
        long lowerValue = dimension == "cpu" ? 150_000 : dimension == "restart" ? 1 : 150;
        var source = new MeasurementSource(s_baseline,
            WithValue(s_baseline, dimension, lowerValue),
            WithValue(s_baseline, dimension, elevatedValue));
        var fixture = new Fixture(source);
        var operation = new Operation(waitForCancellation: true);

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation);

        Assert.Equal(4, source.CallCount);
        Assert.True(operation.CancellationObserved);
        fixture.AssertMeasurementFailure(result);
    }

    [Theory]
    [InlineData("cpu", false)]
    [InlineData("inbound", false)]
    [InlineData("outbound", false)]
    [InlineData("restart", false)]
    [InlineData("network", false)]
    [InlineData("file", false)]
    [InlineData("cpu", true)]
    [InlineData("inbound", true)]
    [InlineData("outbound", true)]
    [InlineData("restart", true)]
    [InlineData("network", true)]
    [InlineData("file", true)]
    public async Task ExecuteAsync_FinalCounterAfterLiveSample_PreservesValidityAndOriginalBudget(
        string dimension,
        bool exceedBudget)
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        long liveValue = dimension == "cpu" ? 6_000_000 : dimension == "restart" ? 2 : 6_000;
        long finalValue = exceedBudget
            ? dimension == "cpu" ? 11_000_000 : dimension == "restart" ? 4 : 11_001
            : dimension == "cpu" ? 5_000_000 : dimension == "restart" ? 1 : 5_000;
        var source = new MeasurementSource(s_baseline,
            WithValue(s_baseline, dimension, finalValue),
            WithValue(s_baseline, dimension, liveValue), release.SetResult);
        var fixture = new Fixture(source);

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(new Operation(release: release.Task));

        Assert.Equal(3, source.CallCount);
        if (exceedBudget)
        {
            Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
            Assert.Equal($"{dimension}-budget-exceeded", result.StableReason);
            Assert.Null(result.Value);
            Assert.Equal(result.StableReason, Assert.Single(fixture.Reasons));
            Assert.Equal(1, fixture.ProbeCount);
        }
        else
        {
            fixture.AssertMeasurementFailure(result);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_InvalidFinalMeasurementAfterCancellationOrCrash_FailsClosed(bool crash)
    {
        using var caller = new CancellationTokenSource();
        var fixture = new Fixture(new MeasurementSource(s_baseline, s_baseline with
        {
            NetworkBytes = 0
        }));
        var operation = new Operation(onReturn: caller.Cancel, crash: crash);

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(operation, caller.Token);

        Assert.True(caller.IsCancellationRequested);
        fixture.AssertMeasurementFailure(result);
    }

    [Fact]
    public async Task ExecuteAsync_LiveAndFinalGaugesDecrease_ReturnsValue()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new MeasurementSource(s_baseline,
            s_baseline with
            {
                MemoryBytes = 0,
                StateBytes = 0
            },
            s_baseline with
            {
                MemoryBytes = 50,
                StateBytes = 50
            }, release.SetResult);
        var fixture = new Fixture(source);

        AuthoringBudgetResult<string> result = await fixture.ExecuteAsync(new Operation(release: release.Task));

        Assert.Equal(3, source.CallCount);
        Assert.Equal(AuthoringBudgetStatus.Completed, result.Status);
        Assert.NotNull(result.Value);
        Assert.Empty(fixture.Reasons);
        Assert.Equal(0, fixture.ProbeCount);
    }

    private static AuthoringResourceMeasurement WithValue(
        AuthoringResourceMeasurement measurement,
        string dimension,
        long value) => dimension switch
        {
            "cpu" => measurement with { CpuTime = TimeSpan.FromTicks(value) },
            "memory" => measurement with { MemoryBytes = value },
            "inbound" => measurement with { InboundBytes = value },
            "outbound" => measurement with { OutboundBytes = value },
            "restart" => measurement with { Restarts = checked((int)value) },
            "network" => measurement with { NetworkBytes = value },
            "file" => measurement with { FileBytes = value },
            "state" => measurement with { StateBytes = value },
            _ => throw new ArgumentOutOfRangeException(nameof(dimension))
        };

    private sealed class Fixture : IAuthoringExtensionContainment,
        IAuthoringBudgetTelemetrySink, IAuthoringCoreContinuityProbe
    {
        private readonly AuthoringExtensionBudgetSupervisor _supervisor;
        private readonly AuthoringBudgetIdentity _identity = new(
            new string('a', 64), "acme.author-tools", "1.0.0", new string('b', 64),
            "acme.command.format", "document-1", "request-1", 1, new string('c', 64));
        private readonly AuthoringResourceBudget _budget = new(
            TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2),
            10_000, 10_000, 10_000, 2, 2, 2, 10_000, 10_000, 10_000);

        public Fixture(IAuthoringResourceMeasurementSource source)
        {
            _supervisor = new(source, this, this, this, TimeProvider.System);
        }

        public List<string> Reasons { get; } = [];
        public List<AuthoringBudgetTelemetry> Telemetry { get; } = [];
        public int ProbeCount
        {
            get; private set;
        }

        public ValueTask<AuthoringBudgetResult<string>> ExecuteAsync(
            Operation operation,
            CancellationToken cancellationToken = default) =>
            _supervisor.ExecuteAsync(_identity, _budget, operation, cancellationToken);

        public void AssertMeasurementFailure(AuthoringBudgetResult<string> result)
        {
            Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
            Assert.Equal("measurement-authority-failed", result.StableReason);
            Assert.Null(result.Value);
            Assert.Equal(result.Status, result.Telemetry.Status);
            Assert.Equal(result.StableReason, result.Telemetry.StableReason);
            Assert.Same(result.Telemetry, Assert.Single(Telemetry));
            Assert.Equal("measurement-authority-failed", Assert.Single(Reasons));
            Assert.Equal(1, ProbeCount);
        }

        public ValueTask QuarantineAsync(AuthoringBudgetIdentity identity, string reason,
            CancellationToken cancellationToken)
        {
            Assert.Equal(_identity, identity);
            Assert.False(cancellationToken.CanBeCanceled);
            Reasons.Add(reason);
            return ValueTask.CompletedTask;
        }

        public ValueTask RecordAsync(AuthoringBudgetTelemetry telemetry, CancellationToken cancellationToken)
        {
            Telemetry.Add(telemetry);
            return ValueTask.CompletedTask;
        }

        public ValueTask<bool> IsCoreAvailableAsync(CancellationToken cancellationToken)
        {
            ProbeCount++;
            return ValueTask.FromResult(true);
        }
    }

    private sealed class MeasurementSource(
        AuthoringResourceMeasurement before,
        AuthoringResourceMeasurement after,
        AuthoringResourceMeasurement? live = null,
        Action? onLive = null) : IAuthoringResourceMeasurementSource
    {
        private int _calls;
        public int CallCount => Volatile.Read(ref _calls);

        public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
            AuthoringBudgetIdentity identity,
            CancellationToken cancellationToken)
        {
            int call = Interlocked.Increment(ref _calls);
            if (call == 2 && live is not null)
            {
                onLive?.Invoke();
            }

            return ValueTask.FromResult(call == 1 ? before : call == 2 && live is not null ? live : after);
        }
    }

    private sealed class Operation(
        bool waitForCancellation = false,
        Task? release = null,
        Action? onReturn = null,
        bool crash = false) : IAuthoringBudgetedRuntimeOperation<string>
    {
        public int CallCount
        {
            get; private set;
        }
        public bool CancellationObserved
        {
            get; private set;
        }

        public async ValueTask<string> ExecuteAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            if (release is not null)
            {
                await release.WaitAsync(cancellationToken);
            }

            if (waitForCancellation)
            {
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    CancellationObserved = true;
                    throw;
                }
            }

            onReturn?.Invoke();
            if (crash)
            {
                throw new InvalidOperationException("runtime crash");
            }

            return "must-not-escape-on-invalid-measurement";
        }
    }
}
