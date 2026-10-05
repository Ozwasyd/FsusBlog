using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSandboxFailureTests
{
    [Fact]
    public void PendingCancellationDoesNotInventFailure()
    {
        using var cancellation = new CancellationTokenSource();

        Assert.False(DocumentExportSandboxRuntime.ShouldRecordCancellation(
            null,
            cancellation.Token));
    }

    [Fact]
    public void CancellationWithoutEarlierFailureIsRecorded()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.True(DocumentExportSandboxRuntime.ShouldRecordCancellation(
            null,
            cancellation.Token));
    }

    [Theory]
    [InlineData("budget")]
    [InlineData("execution")]
    [InlineData("cancelled")]
    public void LateCancellationCannotReplaceEarlierFailure(string kind)
    {
        using var cancellation = new CancellationTokenSource();
        Exception failure = kind switch
        {
            "budget" => new DocumentExportBudgetExceededException(
                "Document export sandbox exceeded its CPU-time budget.",
                "cpu-time-budget"),
            "execution" => new InvalidDataException("Document export execution failed."),
            "cancelled" => new OperationCanceledException("Earlier cancellation."),
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
        Assert.False(DocumentExportSandboxRuntime.ShouldRecordCancellation(
            failure,
            cancellation.Token));
        cancellation.Cancel();

        Assert.False(DocumentExportSandboxRuntime.ShouldRecordCancellation(
            failure,
            cancellation.Token));
    }
}
