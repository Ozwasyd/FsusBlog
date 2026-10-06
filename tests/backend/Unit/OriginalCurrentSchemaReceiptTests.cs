using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Closed input refusals only; these controls do not qualify a receipt, native FD or database.</summary>
public sealed class OriginalCurrentSchemaReceiptTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(6)]
    public void HeldReceipt_RejectsAnyDescriptorOtherThanItsFixedReceiptRole(int descriptor)
    {
        using var cancellation = new CancellationTokenSource();
        string path = Path.Combine(Path.GetTempPath(), "never-opened-original-current-schema.receipt");
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(path, descriptor,
                new string('a', 64), new string('b', 64), cancellation.Token));

        Assert.Equal("current_schema_receipt_original_descriptor_required", error.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("relative/current.receipt")]
    [InlineData("/unopened/latest/current.receipt")]
    [InlineData("/unopened/LaTeSt/current.receipt")]
    [InlineData("/unopened/current.receipt\n")]
    [InlineData("/unopened/../current.receipt")]
    public void HeldReceipt_RejectsMissingLatestOrAliasedSelectorsBeforeNativeDescriptorAccess(string path)
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(path, 5,
                new string('a', 64), new string('b', 64), cancellation.Token));

        Assert.Equal("current_schema_explicit_receipt_required", error.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void HeldReceipt_RejectsInvalidComparisonDigestsBeforeNativeDescriptorAccess(string digest)
    {
        using var cancellation = new CancellationTokenSource();
        const string Path = "/unopened/original-current-schema.receipt";
        Assert.Throws<InvalidOperationException>(() =>
            OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(Path, 5,
                digest, new string('b', 64), cancellation.Token));
        Assert.Throws<InvalidOperationException>(() =>
            OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(Path, 5,
                new string('a', 64), digest, cancellation.Token));
    }

    [Fact]
    public void HeldReceipt_PreCancellationDoesNotBorrowAnUnissuedDescriptor()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.ThrowsAny<OperationCanceledException>(() =>
            OriginalCurrentSchemaReceipt.OpenFromInheritedDescriptor(
                "/unopened/original-current-schema.receipt", 5, string.Empty, string.Empty, cancellation.Token));
    }
}
