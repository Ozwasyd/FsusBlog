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
    public void Actual_Integral_Text_Bytes_Within_The_Original_Budget_Remain_Allowed(long bytes)
        => SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256);

    [Theory]
    [InlineData(-1L)]
    [InlineData(257L)]
    [InlineData(long.MaxValue)]
    public void Negative_Or_Over_Budget_Native_Text_Bytes_Are_Refused(long bytes)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(bytes, 256));

    [Theory]
    [InlineData("128")]
    [InlineData(128.0)]
    [InlineData(null)]
    public void Coerced_Or_Missing_Native_Aggregate_Storage_Is_Not_An_Integral_Byte_Proof(object? value)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(value, 256));

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    public void No_Positive_Finite_Text_Budget_Is_A_Refusal(long maximum)
        => Assert.Throws<InvalidOperationException>(() =>
            SqliteArticlePreservationSourceReader.RequireTextBytes(0L, maximum));

    [Fact]
    public async Task Cancellation_Never_Returns_A_Source_Result_Or_Opens_An_Original_Session()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteArticlePreservationSourceReader.ReadOriginalSessionAsync(
                "not-an-authority-path", null!, null!, null!, null!, TimeSpan.Zero, cancellation.Token));
    }
}
