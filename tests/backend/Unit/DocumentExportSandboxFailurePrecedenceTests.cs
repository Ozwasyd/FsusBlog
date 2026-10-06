using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

// Calls the same terminal classification used by ExecuteAsync. These controls
// do not replace native budget/cleanup execution or create a second receipt model.
public sealed class DocumentExportSandboxFailurePrecedenceTests
{
    [Theory]
    [InlineData("cpu-time-budget")]
    [InlineData("wall-time-budget")]
    [InlineData("memory-budget")]
    [InlineData("process-count-budget")]
    [InlineData("stdout-budget")]
    [InlineData("stderr-budget")]
    [InlineData("output-budget")]
    public void ObservedBudgetFailureIsNotOverwrittenByLaterCancellation(string failureCode)
    {
        using var cancellation = new CancellationTokenSource();
        var first = new DocumentExportBudgetExceededException("Original budget failure.", failureCode);
        var control = Resolve(first, cancellation.Token);
        Assert.Same(first, control.Failure);
        Assert.Equal(failureCode, control.FailureCode);
        Assert.Equal("budget-exceeded", control.Status);
        cancellation.Cancel();
        var result = Resolve(first, cancellation.Token);
        Assert.Same(first, result.Failure);
        Assert.Equal(control.FailureCode, result.FailureCode);
        Assert.Equal(control.Status, result.Status);
    }

    [Theory]
    [InlineData("contract")]
    [InlineData("io")]
    [InlineData("execution")]
    public void ObservedOtherFailureIsNotOverwrittenByLaterCancellation(string kind)
    {
        using var cancellation = new CancellationTokenSource();
        Exception first = kind switch
        {
            "contract" => new InvalidDataException("Original contract failure."),
            "io" => new IOException("Original I/O failure."),
            "execution" => new InvalidOperationException("Original execution failure."),
            _ => throw new InvalidOperationException("Unknown fixture category.")
        };
        var control = Resolve(first, cancellation.Token);
        Assert.Same(first, control.Failure);
        Assert.Equal(kind == "contract" ? "contract-rejected" : "execution-failed", control.FailureCode);
        Assert.Equal("failed", control.Status);
        cancellation.Cancel();
        var result = Resolve(first, cancellation.Token);
        Assert.Same(first, result.Failure);
        Assert.Equal(control.FailureCode, result.FailureCode);
        Assert.Equal(control.Status, result.Status);
    }

    [Fact]
    public void CancellationWithoutObservedFailureStillUsesOriginalCancellationCategory()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var result = Resolve(null, cancellation.Token);
        OperationCanceledException failure = Assert.IsType<OperationCanceledException>(result.Failure);
        Assert.Equal(cancellation.Token, failure.CancellationToken);
        Assert.Equal("cancelled", result.FailureCode);
        Assert.Equal("cancelled", result.Status);
    }

    [Fact]
    public void PreviouslyObservedCancellationRetainsItsOriginalCauseAndToken()
    {
        using var originalCancellation = new CancellationTokenSource();
        using var lateCancellation = new CancellationTokenSource();
        originalCancellation.Cancel();
        var first = new OperationCanceledException("Original cancellation.", originalCancellation.Token);
        lateCancellation.Cancel();
        var result = Resolve(first, lateCancellation.Token);
        Assert.Same(first, result.Failure);
        Assert.Equal(originalCancellation.Token, first.CancellationToken);
        Assert.Equal("cancelled", result.FailureCode);
        Assert.Equal("cancelled", result.Status);
    }

    [Fact]
    public void QualifiedCompletionWithoutFailureOrCancellationRemainsSuccessful()
    {
        var result = Resolve(null, CancellationToken.None);
        Assert.Null(result.Failure);
        Assert.Equal("none", result.FailureCode);
        Assert.Equal("succeeded", result.Status);
    }

    [Theory]
    [InlineData(false, true, 0, false, true, true)]
    [InlineData(true, false, 0, false, true, true)]
    [InlineData(true, true, 1, false, true, true)]
    [InlineData(true, true, 0, true, true, true)]
    [InlineData(true, true, 0, false, false, true)]
    [InlineData(true, true, 0, false, true, false)]
    public void EveryUnqualifiedCleanupConditionStillRejectsAndRetainsFirstBudgetCause(
        bool terminated, bool removed, int remaining, bool populated, bool unitRemoved, bool cgroupRemoved)
    {
        var first = new DocumentExportBudgetExceededException("Original CPU budget failure.", "cpu-time-budget");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var result = DocumentExportSandboxRuntime.ResolveTerminalFailure(first,
            DocumentExportSandboxRuntime.ClassifyFailure(first), cancellation.Token,
            terminated, removed, remaining, populated, unitRemoved, cgroupRemoved);
        InvalidDataException cleanup = Assert.IsType<InvalidDataException>(result.Failure);
        Assert.Same(first, cleanup.InnerException);
        Assert.Equal("cleanup-unqualified", result.FailureCode);
        Assert.Equal("cleanup-required", result.Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UnqualifiedCleanupRetainsOtherOrCancellationCause(bool alreadyCancelled)
    {
        using var cancellation = new CancellationTokenSource();
        Exception first = alreadyCancelled ? new OperationCanceledException("Original cancellation.")
            : new InvalidDataException("Original contract failure.");
        cancellation.Cancel();
        var result = DocumentExportSandboxRuntime.ResolveTerminalFailure(first,
            DocumentExportSandboxRuntime.ClassifyFailure(first), cancellation.Token,
            true, false, 0, false, true, true);
        InvalidDataException cleanup = Assert.IsType<InvalidDataException>(result.Failure);
        Assert.Same(first, cleanup.InnerException);
        Assert.Equal("cleanup-unqualified", result.FailureCode);
        Assert.Equal("cleanup-required", result.Status);
    }

    private static (Exception? Failure, string FailureCode, string Status) Resolve(Exception? first, CancellationToken token)
        => DocumentExportSandboxRuntime.ResolveTerminalFailure(first,
            first is null ? "none" : DocumentExportSandboxRuntime.ClassifyFailure(first), token,
            true, true, 0, false, true, true);
}
