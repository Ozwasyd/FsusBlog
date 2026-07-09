using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Property")]
public sealed class BackendPropertyTests
{
    private const int Seed = 40721;

    [Fact]
    public void AedsRoundTripProperty_PreservesPayloadAndFrameType()
    {
        var encoder = new AedsEncoder();
        AedsFrameType[] frameTypes = Enum.GetValues<AedsFrameType>()
            .Where(static frameType => frameType != AedsFrameType.Unknown)
            .ToArray();

        foreach (AedsFrameType frameType in frameTypes)
        {
            foreach (byte[] payload in GeneratePayloads((int)frameType + Seed))
            {
                byte[] frame = encoder.Encode(frameType, payload);
                var decoded = encoder.TryDecode(frame);

                Assert.True(decoded.IsSuccess);
                Assert.Equal(frameType, decoded.Value.FrameType);
                Assert.Equal((uint)payload.Length, decoded.Value.Header.PayloadLength);
                Assert.True(decoded.Value.Payload.Span.SequenceEqual(payload));
            }
        }
    }

    [Fact]
    public void AedsTruncationProperty_ReturnsProtocolFailureInsteadOfThrowing()
    {
        var encoder = new AedsEncoder();
        byte[] payload = GeneratePayloads(Seed).Last();
        byte[] frame = encoder.Encode(AedsFrameType.ArticleDetail, payload);

        for (int length = 0; length < frame.Length; length++)
        {
            byte[] truncated = frame[..length];
            var decoded = encoder.TryDecode(truncated);

            Assert.False(decoded.IsSuccess);
        }
    }

    [Fact]
    public void AedsBitFlipProperty_DetectsPayloadCorruption()
    {
        var encoder = new AedsEncoder();
        byte[] frame = encoder.Encode(AedsFrameType.ApiError, GeneratePayloads(Seed + 1).Last());

        for (int offset = AedsFrameHeader.Size; offset < frame.Length; offset += 3)
        {
            byte[] mutated = (byte[])frame.Clone();
            mutated[offset] ^= 0x5a;

            var decoded = encoder.TryDecode(mutated);

            Assert.False(decoded.IsSuccess);
        }
    }

    [Fact]
    public void CacheKeyProperty_IsDeterministicAndKeepsNamespacesSeparated()
    {
        var publicPages = Enum.GetValues<PublicPageId>();

        for (int i = 0; i < 128; i++)
        {
            int page = 1 + (i % 11);
            int size = 5 + (i % 40);
            int? categoryId = i % 3 == 0 ? i : null;
            int? tagId = i % 5 == 0 ? i + 1 : null;
            bool isDeleted = i % 7 == 0;
            string listKey = TestCacheKeyBuilder.ArticleList(page, size, categoryId, tagId, isDeleted);
            string listKeyAgain = TestCacheKeyBuilder.ArticleList(page, size, categoryId, tagId, isDeleted);
            string detailKey = TestCacheKeyBuilder.ArticleDetail(i + 1);
            PublicPageId pageId = publicPages[i % publicPages.Length];
            string routeKey = $"route-{i}:article-{i + 10}";
            string shellKey = TestCacheKeyBuilder.PublicAotShell(pageId, routeKey);
            string documentKey = CacheKeyBuilder.PublicAotDocument(pageId, routeKey);

            Assert.Equal(listKey, listKeyAgain);
            Assert.StartsWith("pod:v1:", listKey, StringComparison.Ordinal);
            Assert.StartsWith("pod:v1:", detailKey, StringComparison.Ordinal);
            Assert.StartsWith("public:aot:v2:", shellKey, StringComparison.Ordinal);
            Assert.StartsWith("public:aot:v2:doc:", documentKey, StringComparison.Ordinal);
            Assert.NotEqual(listKey, detailKey);
            Assert.NotEqual(shellKey, documentKey);
        }
    }

    [Fact]
    public void UploadRangeProperty_NormalizesOverlapAndRequiresAllPartsForComplete()
    {
        var samples = new[]
        {
            new[] { (Start: 0, End: 2), (Start: 2, End: 4), (Start: 7, End: 7) },
            new[] { (Start: 3, End: 1), (Start: 1, End: 3), (Start: 3, End: 5) },
            new[] { (Start: -2, End: 1), (Start: 6, End: 9), (Start: 0, End: 0) }
        };

        foreach (var ranges in samples)
        {
            int[] uploadedParts = ExpandUploadedRanges(ranges, partCount: 8);

            Assert.All(uploadedParts, part => Assert.InRange(part, 0, 7));
            Assert.Equal(uploadedParts, uploadedParts.Distinct().Order().ToArray());
            Assert.Equal(uploadedParts.Length == 8, IsComplete(uploadedParts, partCount: 8));
        }
    }

    private static IEnumerable<byte[]> GeneratePayloads(int seed)
    {
        yield return [];
        yield return [0];
        yield return [0, 1, 2, 3, 4, 5, 6, 7];

        var random = new Random(seed);
        foreach (int size in new[] { 16, 64, 255, 1024 })
        {
            var payload = new byte[size];
            random.NextBytes(payload);
            yield return payload;
        }
    }

    private static int[] ExpandUploadedRanges(IEnumerable<(int Start, int End)> ranges, int partCount)
    {
        var parts = new SortedSet<int>();
        foreach ((int startRaw, int endRaw) in ranges)
        {
            int start = Math.Clamp(Math.Min(startRaw, endRaw), 0, partCount - 1);
            int end = Math.Clamp(Math.Max(startRaw, endRaw), 0, partCount - 1);
            for (int part = start; part <= end; part++)
            {
                parts.Add(part);
            }
        }

        return parts.ToArray();
    }

    private static bool IsComplete(IReadOnlyCollection<int> uploadedParts, int partCount)
        => uploadedParts.Count == partCount
           && uploadedParts.Min() == 0
           && uploadedParts.Max() == partCount - 1;
}
