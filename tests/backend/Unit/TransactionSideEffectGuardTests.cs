using FsusBlog.Server.Infrastructure.Execution;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class TransactionSideEffectGuardTests
{
    [Fact]
    public void CanPublishAfterCommit_FalseResult_ReturnsFalse()
    {
        var result = new FakeTransactionResult(false, "rolled back", null);

        bool canPublish = TransactionSideEffectGuard.CanPublishAfterCommit(result, NullLogger.Instance, "test-operation");

        Assert.False(canPublish);
    }

    [Fact]
    public void CanPublishAfterCommit_TrueResult_ReturnsTrue()
    {
        var result = new FakeTransactionResult(true, null, null);

        bool canPublish = TransactionSideEffectGuard.CanPublishAfterCommit(result, NullLogger.Instance, "test-operation");

        Assert.True(canPublish);
    }

    private sealed record FakeTransactionResult(bool IsSuccess, string? ErrorMessage, Exception? ErrorException);
}
