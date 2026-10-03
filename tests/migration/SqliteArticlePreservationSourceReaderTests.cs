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
    public void Actual_integral_text_bytes_within_the_original_budget_remain_allowed(long bytes)
        => SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256);

    [Theory]
    [InlineData(-1L)]
    [InlineData(257L)]
    [InlineData(long.MaxValue)]
    public void Negative_or_over_budget_native_text_bytes_are_refused(long bytes)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256));

    [Theory]
    [InlineData("128")]
    [InlineData(128.0)]
    [InlineData(null)]
    public void Coerced_or_missing_native_aggregate_storage_is_not_an_integral_byte_proof(object? value)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(value, 256));

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    public void No_positive_finite_text_budget_is_a_refusal(long maximum)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(0L, maximum));

    [Fact]
    public async Task Cancellation_never_returns_a_source_result_or_opens_an_original_session()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteArticlePreservationSourceReader.ReadOriginalSessionAsync(
                "not-an-authority-path", null!, null!, null!, null!, TimeSpan.Zero, cancellation.Token));
    }
}
