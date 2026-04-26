using System.Numerics;
using System.Text;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests;

public sealed class SearchIndexServiceTests
{
    [Theory]
    [InlineData(" Hello ", "hello")]
    [InlineData("你好", "你好")]
    [InlineData("MixedCase词", "mixedcase词")]
    [InlineData("   ", null)]
    [InlineData("", null)]
    public void NormalizeTokenForTests_MatchesExpectedNormalization(string input, string? expected)
    {
        string? actual = SearchIndexService.NormalizeTokenForTests(input);

        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData("")]
    [InlineData("hello")]
    [InlineData("你好")]
    [InlineData("Hello你好123")]
    [InlineData(" very long token with spaces trimmed ")]
    public void HashTokenForTests_MatchesLegacyHash(string input)
    {
        uint actual = SearchIndexService.HashTokenForTests(input);

        Assert.Equal(ComputeLegacyHashUtf8(input), actual);
    }

    [Fact]
    public void TokenizeForTests_PrefersHigherFrequencyLongerPath_AndEmitsDictionarySubtokens()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "北京\t50",
                "大学\t50",
                "北京大学\t500",
                "北京大\t10"
            ]);

        SearchIndexService.SearchTokenDebugView[] tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "北京大学");

        Assert.Collection(
            tokens,
            token =>
            {
                Assert.Equal("北京大学", token.Text);
                Assert.Equal(SearchIndexService.HashTokenForTests("北京大学"), token.Hash);
                Assert.Equal(0u, token.Position);
                Assert.Equal(4u, token.PositionLength);
                Assert.False(token.Stopword);
                Assert.True(token.KeepPositionsCandidate);
            },
            token =>
            {
                Assert.Equal("北京", token.Text);
                Assert.Equal(SearchIndexService.HashTokenForTests("北京"), token.Hash);
                Assert.Equal(0u, token.Position);
                Assert.Equal(2u, token.PositionLength);
            },
            token =>
            {
                Assert.Equal("北京大", token.Text);
                Assert.Equal(SearchIndexService.HashTokenForTests("北京大"), token.Hash);
                Assert.Equal(0u, token.Position);
                Assert.Equal(3u, token.PositionLength);
            },
            token =>
            {
                Assert.Equal("大学", token.Text);
                Assert.Equal(SearchIndexService.HashTokenForTests("大学"), token.Hash);
                Assert.Equal(2u, token.Position);
                Assert.Equal(2u, token.PositionLength);
            });
    }

    [Fact]
    public void TokenizeForTests_FallsBackToUnigram_ForUnknownCjkSegment()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: ["已知\t5"]);

        SearchIndexService.SearchTokenDebugView[] tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "甲乙");

        Assert.Collection(
            tokens,
            token =>
            {
                Assert.Equal(SearchIndexService.HashTokenForTests("甲"), token.Hash);
                Assert.Equal(0u, token.Position);
                Assert.Equal(1u, token.PositionLength);
            },
            token =>
            {
                Assert.Equal(SearchIndexService.HashTokenForTests("乙"), token.Hash);
                Assert.Equal(1u, token.Position);
                Assert.Equal(1u, token.PositionLength);
            });
    }

    [Fact]
    public void TokenizeForTests_NormalizesAsciiAndSplitsOnBoundaries()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);

        SearchIndexService.SearchTokenDebugView[] tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "Hello123 WORLD");

        Assert.Collection(
            tokens,
            token =>
            {
                Assert.Equal(SearchIndexService.HashTokenForTests("hello123"), token.Hash);
                Assert.Equal(0u, token.Position);
                Assert.Equal(1u, token.PositionLength);
            },
            token =>
            {
                Assert.Equal(SearchIndexService.HashTokenForTests("world"), token.Hash);
                Assert.Equal(1u, token.Position);
                Assert.Equal(1u, token.PositionLength);
            });
    }

    [Theory]
    [InlineData(0, 95, false, true, false)]
    [InlineData(5, 95, true, true, false)]
    [InlineData(5, 95, false, false, false)]
    [InlineData(5, 95, false, true, true)]
    [InlineData(95, 95, false, true, false)]
    public void ShouldKeepPositionsForTests_RespectsStopwordCandidateAndFrequencyCutoff(
        int documentFrequency,
        int cutoff,
        bool stopword,
        bool keepCandidate,
        bool expected)
    {
        bool actual = SearchIndexService.ShouldKeepPositionsForTests(documentFrequency, cutoff, stopword, keepCandidate);

        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(10, 10)]
    [InlineData(11, 11)]
    [InlineData(12, 11)]
    [InlineData(13, 12)]
    [InlineData(16, 13)]
    [InlineData(24, 14)]
    [InlineData(40, 15)]
    [InlineData(90, 16)]
    [InlineData(200, 17)]
    public void QuantizeTfForTests_UsesExpectedBuckets(int raw, byte expected)
    {
        Assert.Equal(expected, SearchIndexService.QuantizeTfForTests(raw));
    }

    [Theory]
    [InlineData(100, 10, 5, 1000, 10000, true)]
    [InlineData(100, 21, 5, 1000, 10000, false)]
    [InlineData(100, 10, 16, 1000, 10000, false)]
    [InlineData(100, 10, 5, 2600, 10000, false)]
    [InlineData(100, 0, 0, 1000, 10000, false)]
    [InlineData(100, 0, 4, 1000, 10000, true)]
    public void ShouldEmitPatchForTests_EnforcesThresholds(
        int shardDocCount,
        int patchDocCount,
        int tombstoneCount,
        int patchBytesLength,
        int shardBytesLength,
        bool expected)
    {
        bool actual = SearchIndexService.ShouldEmitPatchForTests(
            shardDocCount,
            patchDocCount,
            tombstoneCount,
            patchBytesLength,
            shardBytesLength);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void ValidateDictionaryHeaderForTests_InvalidHeader_DoesNotKeepFileLocked()
    {
        string path = Path.Combine(Path.GetTempPath(), $"fsus-search-dict-{Guid.NewGuid():N}.bin");
        File.WriteAllBytes(path, new byte[16]);

        try
        {
            Assert.Throws<InvalidDataException>(() => SearchIndexService.ValidateDictionaryHeaderForTests(path));

            byte[] replacement = Enumerable.Repeat((byte)0x5A, 32).ToArray();
            File.WriteAllBytes(path, replacement);
            Assert.Equal(replacement.Length, new FileInfo(path).Length);
        }
        finally
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }

    private static string CreateLexiconRoot(IEnumerable<string> coreEntries, IEnumerable<string>? domainEntries = null, IEnumerable<string>? stopwords = null)
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsus-search-lexicon-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        File.WriteAllLines(Path.Combine(root, "core.dict.txt"), coreEntries, Encoding.UTF8);
        File.WriteAllLines(Path.Combine(root, "domain.dict.txt"), domainEntries ?? [], Encoding.UTF8);
        File.WriteAllLines(Path.Combine(root, "stopwords.txt"), stopwords ?? [], Encoding.UTF8);
        return root;
    }

    private static uint ComputeLegacyHashUtf8(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        const uint c1 = 0xcc9e2d51;
        const uint c2 = 0x1b873593;
        uint h1 = 0;
        int length = bytes.Length;
        int roundedEnd = length & ~0x3;

        for (int i = 0; i < roundedEnd; i += 4)
        {
            uint k1 = (uint)(bytes[i]
                | bytes[i + 1] << 8
                | bytes[i + 2] << 16
                | bytes[i + 3] << 24);

            k1 *= c1;
            k1 = BitOperations.RotateLeft(k1, 15);
            k1 *= c2;

            h1 ^= k1;
            h1 = BitOperations.RotateLeft(h1, 13);
            h1 = h1 * 5 + 0xe6546b64;
        }

        uint tail = 0;
        switch (length & 3)
        {
            case 3:
                tail ^= (uint)bytes[roundedEnd + 2] << 16;
                goto case 2;
            case 2:
                tail ^= (uint)bytes[roundedEnd + 1] << 8;
                goto case 1;
            case 1:
                tail ^= bytes[roundedEnd];
                tail *= c1;
                tail = BitOperations.RotateLeft(tail, 15);
                tail *= c2;
                h1 ^= tail;
                break;
        }

        h1 ^= (uint)length;
        h1 ^= h1 >> 16;
        h1 *= 0x85ebca6b;
        h1 ^= h1 >> 13;
        h1 *= 0xc2b2ae35;
        h1 ^= h1 >> 16;
        return h1;
    }
}
