using System.Buffers;
using System.Buffers.Binary;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultCurrentReviewWireTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Request_MatchesIndependentLiteralAndPreservesEveryReference(bool checkpoint)
    {
        byte[] literal = Literal(checkpoint);
        ArticleVaultCurrentReviewRequest expected = Request(checkpoint);
        Assert.Equal(literal, PodBinaryCodec.EncodeArticleVaultCurrentReviewRequest(expected));
        Assert.True(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(literal, out var actual));
        Assert.Equal(expected, actual);
        Assert.Equal(3_176, literal.Length);
        Assert.Equal(3_192, ArticleVaultCurrentReviewWireContract.RequestFrameBytes);
        literal.AsSpan().Clear();
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(4, 2)]
    [InlineData(6, 2)]
    [InlineData(12, 1)]
    [InlineData(16, 0)]
    [InlineData(27, 65)]
    [InlineData(91, 1)]
    [InlineData(96, 65)]
    [InlineData(167, 255)]
    [InlineData(168, 65)]
    [InlineData(232, 0)]
    [InlineData(275, 1)]
    [InlineData(280, 2)]
    [InlineData(284, 1)]
    [InlineData(288, 32)]
    [InlineData(289, 192)]
    [InlineData(310, 1)]
    [InlineData(800, 47)]
    [InlineData(1312, 92)]
    [InlineData(1824, 9)]
    [InlineData(2848, 65)]
    [InlineData(2912, 65)]
    [InlineData(2976, 65)]
    [InlineData(3047, 255)]
    [InlineData(3048, 65)]
    [InlineData(3112, 65)]
    public void Request_MalformedClosedFieldsNeverProduceAPartialRequest(int offset, byte replacement)
    {
        byte[] literal = Literal(true);
        literal[offset] = replacement;
        Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(literal, out var value));
        Assert.Null(value);
    }

    [Fact]
    public void Request_AbsentCheckpointRefusesHiddenDataAndExcessBytes()
    {
        byte[] literal = Literal(false);
        literal[160] = 1;
        Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(literal, out _));
        Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(new byte[3_175], out _));
        Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(new byte[3_177], out _));
    }

    [Fact]
    public void Request_UnsafeIntegersAndZeroArticleAreRejectedWithoutTruncation()
    {
        foreach (int offset in new[] { 160, 3040 })
        {
            byte[] bytes = Literal(true);
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset), ArticleVaultCurrentReviewWireContract.MaxWireInteger + 1);
            Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(bytes, out _));
        }
        byte[] zero = Literal(false);
        zero.AsSpan(8, 4).Clear();
        Assert.False(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(zero, out _));
    }

    [Fact]
    public void Request_IdentityBoundIsUtf16AndInvalidInputDoesNotTouchDestination()
    {
        ArticleVaultCurrentReviewRequest expected = Request(true);
        var operation = expected.Checkpoint!.Operation with
        {
            SiteIdentity = new string('中', 128)
        };
        var atBound = expected with
        {
            Checkpoint = expected.Checkpoint with
            {
                Operation = operation
            }
        };
        Assert.True(PodBinaryCodec.TryDecodeArticleVaultCurrentReviewRequest(
            PodBinaryCodec.EncodeArticleVaultCurrentReviewRequest(atBound), out var decoded));
        Assert.Equal(atBound, decoded);
        var target = new ArrayBufferWriter<byte>();
        target.GetSpan(1)[0] = 42;
        target.Advance(1);
        var tooLarge = atBound with
        {
            Checkpoint = atBound.Checkpoint! with
            {
                Operation = operation with
                {
                    SiteIdentity = new string('中', 129)
                }
            }
        };
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteArticleVaultCurrentReviewRequest(tooLarge, target));
        Assert.Equal(new byte[] { 42 }, target.WrittenSpan.ToArray());
        Assert.False(ArticleVaultCurrentReviewWireContract.IsValid(expected with
        {
            Checkpoint = expected.Checkpoint with
            {
                Operation = operation with
                {
                    SiteIdentity = "bad\ud800"
                }
            }
        }));
    }

    private static ArticleVaultCurrentReviewRequest Request(bool checkpoint)
        => new(1_234_567, "resolution-" + new string('a', 64), new string('b', 64), checkpoint
            ? new(new(ArticleVaultOperationSchemas.Identity, 1, "site-中😀", "vault-one", "device-one", "agent-one", "plan-one",
                new string('c', 64), new string('d', 64), new string('e', 64), 1_700_000_000_123,
                new string('f', 64), new string('a', 64)), 2, new string('9', 64)) : null);

    private static byte[] Literal(bool checkpoint)
        => Convert.FromHexString(BackendTestPaths.ReadAllTextFromRoot(
            "tests", "fixtures", "article-vault-current-review-wire", checkpoint ? "exact-checkpoint.hex" : "proposal-only.hex").Trim());
}
