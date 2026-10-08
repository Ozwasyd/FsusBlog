using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class DocumentExportAttemptResourcesTests
{
    [Fact]
    public void WiderRuntime_CannotLoosenTheOwnerPerFileCeiling()
    {
        var fixture = new Fixture();
        DocumentExportResourceBudgets wider = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets;
        using DocumentExportAttemptResources.Stage stage = fixture.Resources.BeginStage(
            fixture.Task, fixture.Input, wider, canonicalRenderer: true);

        Assert.Equal(fixture.Maximum.MaxFileBytes, stage.Budgets.MaxFileBytes);
        Assert.Equal(fixture.Maximum.MaxWorkingSetBytes, stage.Budgets.MaxWorkingSetBytes);
        Assert.Equal(fixture.Maximum.CpuTime, stage.Budgets.CpuTime);
        Assert.Equal(fixture.Maximum.MaxFileCount, stage.Budgets.MaxFileCount);
        Assert.Equal(fixture.Maximum.MaxInputBytes, stage.Budgets.MaxInputBytes);
        Assert.Equal(fixture.Maximum.MaxOutputBytes, stage.Budgets.MaxOutputBytes);
        Assert.Equal(fixture.Maximum.MaxStandardOutputBytes, stage.Budgets.MaxStandardOutputBytes);
        Assert.Equal(fixture.Maximum.MaxStandardErrorBytes, stage.Budgets.MaxStandardErrorBytes);
        Assert.Null(stage.Complete(qualified: true));
    }

    [Fact]
    public void LaterStage_UsesRemainingNativeAndMutableFileEnvelope()
    {
        var fixture = new Fixture();
        using (DocumentExportAttemptResources.Stage renderer = fixture.Begin(canonicalRenderer: true))
        {
            renderer.Observe(1_000_000, 3, 400, 200, 300, 50, 50);
            // A later smaller sample cannot erase an observed high-water mark.
            renderer.Observe(500_000, 2, 200, 100, 100, 20, 20);
            Assert.Null(renderer.Complete(qualified: true));
        }
        fixture.Clock.Advance(TimeSpan.FromSeconds(3));
        using DocumentExportAttemptResources.Stage conversion = fixture.Begin(canonicalRenderer: false);

        Assert.Equal(TimeSpan.FromSeconds(3), conversion.Budgets.CpuTime);
        Assert.Equal(TimeSpan.FromSeconds(17), conversion.Budgets.WallTime);
        Assert.Equal(5, conversion.Budgets.MaxFileCount);
        Assert.Equal(800, conversion.Budgets.MaxFileBytes);
        Assert.Equal(800, conversion.FileBytesBudget);
        Assert.Equal(800, conversion.Budgets.MaxInputBytes);
        Assert.Equal(700, conversion.Budgets.MaxOutputBytes);
        Assert.Equal(50, conversion.Budgets.MaxStandardOutputBytes);
        Assert.Equal(50, conversion.Budgets.MaxStandardErrorBytes);
        Assert.Equal(fixture.Maximum.MaxWorkingSetBytes, conversion.Budgets.MaxWorkingSetBytes);
        Assert.Equal(fixture.Maximum.MaxMessageBytes, conversion.Budgets.MaxMessageBytes);
        Assert.Equal(fixture.Maximum.MaxProcessCount, conversion.Budgets.MaxProcessCount);
        Assert.Null(conversion.Complete(qualified: true));
        fixture.Resources.RequireCompleted();
    }

    [Theory]
    [InlineData("cpu", "task-cpu-time-budget")]
    [InlineData("files", "task-file-count-budget")]
    [InlineData("file-bytes", "task-file-bytes-budget")]
    [InlineData("input", "task-input-budget")]
    [InlineData("output", "task-output-budget")]
    [InlineData("stdout", "task-stdout-budget")]
    [InlineData("stderr", "task-stderr-budget")]
    public void CombinedStageOverrun_IsStickyAndCannotReset(string dimension, string code)
    {
        var fixture = new Fixture();
        using (DocumentExportAttemptResources.Stage renderer = fixture.Begin(canonicalRenderer: true))
        {
            renderer.Observe(1_000_000, 3, 400, 200, 300, 50, 50);
            Assert.Null(renderer.Complete(qualified: true));
        }
        using (DocumentExportAttemptResources.Stage conversion = fixture.Begin(canonicalRenderer: false))
        {
            conversion.Observe(
                dimension == "cpu" ? 4_000_000 : 0,
                dimension == "files" ? 6 : 1,
                dimension == "file-bytes" ? 801 : 100,
                dimension == "input" ? 801 : 1,
                dimension == "output" ? 701 : 1,
                dimension == "stdout" ? 51 : 1,
                dimension == "stderr" ? 51 : 1);
            var failure = Assert.IsType<DocumentExportBudgetExceededException>(conversion.Complete(qualified: true));
            Assert.Equal(code, failure.FailureCode);
        }
        Assert.Throws<InvalidDataException>(fixture.Resources.RequireCompleted);
        Assert.Throws<InvalidOperationException>(() => fixture.Begin(canonicalRenderer: false));
    }

    [Fact]
    public void HostOutput_IsChargedAlongsideNativeOutput()
    {
        var fixture = new Fixture();
        using (DocumentExportAttemptResources.Stage renderer = fixture.Begin(canonicalRenderer: true))
        {
            renderer.Observe(1, 3, 700, 200, 700, 0, 0);
            Assert.Null(renderer.Complete(qualified: true));
        }
        fixture.Resources.AccountHostOutputBytes(300);
        DocumentExportBudgetExceededException failure = Assert.Throws<DocumentExportBudgetExceededException>(() =>
            fixture.Resources.AccountHostOutputBytes(1));
        Assert.Equal("task-output-budget", failure.FailureCode);
        Assert.Throws<InvalidDataException>(fixture.Resources.RequireCompleted);
    }

    [Theory]
    [InlineData("failed")]
    [InlineData("abandoned")]
    [InlineData("overlap")]
    [InlineData("duplicate-stage")]
    [InlineData("sealed")]
    public void Attempt_CannotRetryOverlapAbandonOrReuseItsStages(string condition)
    {
        var fixture = new Fixture();
        using (DocumentExportAttemptResources.Stage stage = fixture.Begin(canonicalRenderer: true))
        {
            if (condition == "overlap")
            {
                Assert.Throws<InvalidOperationException>(() => fixture.Begin(canonicalRenderer: false));
            }
            if (condition != "abandoned")
            {
                Assert.Null(stage.Complete(qualified: condition != "failed"));
            }
        }
        if (condition == "sealed")
        {
            fixture.Resources.RequireCompleted();
        }
        Assert.Throws<InvalidOperationException>(() =>
            fixture.Begin(canonicalRenderer: condition == "duplicate-stage"));
        Assert.Throws<InvalidDataException>(fixture.Resources.RequireCompleted);
    }

    [Fact]
    public void Attempt_RefusesAnotherResealedOwnerScope()
    {
        var fixture = new Fixture();
        DocumentExportFrozenInput otherInput = DocumentExportContractValidator.Seal(fixture.Input with
        {
            SiteScope = "https://other.test"
        });
        DocumentExportTask otherTask = DocumentExportContractTests.ValidTask(otherInput);

        Assert.Throws<InvalidDataException>(() => fixture.Resources.BeginStage(
            otherTask, otherInput, fixture.Maximum, canonicalRenderer: true));
        Assert.Throws<InvalidDataException>(fixture.Resources.RequireCompleted);
    }

    [Fact]
    public void Attempt_ElapsedWallDoesNotRestartAtTheNextStage()
    {
        var fixture = new Fixture();
        using (DocumentExportAttemptResources.Stage renderer = fixture.Begin(canonicalRenderer: true))
        {
            Assert.Null(renderer.Complete(qualified: true));
        }
        fixture.Clock.Advance(fixture.Maximum.WallTime);

        DocumentExportBudgetExceededException failure = Assert.Throws<DocumentExportBudgetExceededException>(() =>
            fixture.Begin(canonicalRenderer: false));
        Assert.Equal("task-wall-time-budget", failure.FailureCode);
        Assert.Throws<InvalidDataException>(fixture.Resources.RequireCompleted);
    }

    [Fact]
    public void Stage_CannotBeAccountedTwice()
    {
        var fixture = new Fixture();
        using DocumentExportAttemptResources.Stage stage = fixture.Begin(canonicalRenderer: true);
        Assert.Null(stage.Complete(qualified: true));
        Assert.Throws<InvalidOperationException>(() => stage.Complete(qualified: true));
    }

    private sealed class Fixture
    {
        public DocumentExportFrozenInput Input { get; } = DocumentExportContractTests.ValidInput();
        public DocumentExportTask Task { get; }
        public Clock Clock { get; } = new();
        public DocumentExportResourceBudgets Maximum
        {
            get;
        } =
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                WallTime = TimeSpan.FromSeconds(20),
                CpuTime = TimeSpan.FromSeconds(4),
                MaxFileCount = 8,
                MaxFileBytes = 1000,
                MaxInputBytes = 1000,
                MaxOutputBytes = 1000,
                MaxStandardOutputBytes = 100,
                MaxStandardErrorBytes = 100
            };
        public DocumentExportAttemptResources Resources { get; }

        public Fixture()
        {
            Task = DocumentExportContractTests.ValidTask(Input);
            Resources = new(Task, Input, Maximum, Clock);
        }

        public DocumentExportAttemptResources.Stage Begin(bool canonicalRenderer)
            => Resources.BeginStage(Task, Input, Maximum, canonicalRenderer);
    }

    private sealed class Clock : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _timestamp;
        public void Advance(TimeSpan elapsed) => _timestamp += elapsed.Ticks;
    }
}
