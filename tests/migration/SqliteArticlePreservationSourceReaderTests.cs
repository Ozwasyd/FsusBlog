using Xunit;

namespace FsusBlog.Migration.Tests;

// Exact production budget controls only; no fixture fabricates held FILESTAT,
// a known database profile, a source read result or a provider qualification.
public sealed class SqliteArticlePreservationSourceReaderTests
{
    [Theory]
    [InlineData(0L)]
    [InlineData(128L)]
    [InlineData(256L)]
    public void ActualIntegralTextBytesWithinTheOriginalBudgetRemainAllowed(long bytes)
        => SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256);

    [Theory]
    [InlineData(-1L)]
    [InlineData(257L)]
    [InlineData(long.MaxValue)]
    public void NegativeOrOverBudgetNativeTextBytesAreRefused(long bytes)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256));

    [Theory]
    [InlineData("128")]
    [InlineData(128.0)]
    [InlineData(null)]
    public void CoercedOrMissingNativeAggregateStorageIsNotAnIntegralByteProof(object? value)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(value, 256));

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    public void NoPositiveFiniteTextBudgetIsARefusal(long maximum)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(0L, maximum));

    [Fact]
    public async Task CancellationNeverReturnsASourceResultOrOpensAnOriginalSession()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteArticlePreservationSourceReader.ReadOriginalSessionAsync(
                "not-an-authority-path", null!, null!, null!, null!, TimeSpan.Zero, cancellation.Token));
    }
}
