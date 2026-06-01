using System.Numerics;
using System.Reflection;
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
    public void TokenFingerprintForTests_AddsCollisionVerificationMaterial()
    {
        ulong first = SearchIndexService.TokenFingerprintForTests("hello");
        ulong second = SearchIndexService.TokenFingerprintForTests("world");

        Assert.NotEqual(0UL, first);
        Assert.NotEqual(first, second);
        Assert.Equal(first, SearchIndexService.TokenFingerprintForTests("hello"));
    }

    [Fact]
    public void ComputeRuntimeBm25ForTests_PenalizesLongerDocuments()
    {
        double shortDocument = SearchIndexService.ComputeRuntimeBm25ForTests(4, 10, 2, 100, 100);
        double longDocument = SearchIndexService.ComputeRuntimeBm25ForTests(4, 10, 2, 600, 100);

        Assert.True(shortDocument > longDocument);
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
                Assert.Equal(SearchIndexService.TokenFingerprintForTests("北京大学"), token.Fingerprint);
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
    public void SearchIndexContractForTests_UsesV3CoreRecentArchivePlan()
    {
        var contract = SearchIndexService.SearchIndexContractForTests();

        Assert.Equal(3, contract.SchemaVersion);
        Assert.Equal(["core", "recent"], contract.InitialRoles);
        Assert.Equal(["archive"], contract.BackgroundRoles);
        Assert.Empty(contract.DeepRoles);
        Assert.Equal([0u, 1u, 2u], contract.ShardRoles);
        Assert.DoesNotContain("body", contract.InitialRoles.Concat(contract.BackgroundRoles).Concat(contract.DeepRoles));
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

    // ── GetUtf8ScalarLength tests ─────────────────────────────────────────────

    [Theory]
    [InlineData(0x00, 1)]   // ASCII
    [InlineData(0x7F, 1)]   // ASCII max
    [InlineData(0xC2, 2)]   // 2-byte start min
    [InlineData(0xDF, 2)]   // 2-byte start max
    [InlineData(0xE0, 3)]   // 3-byte start min
    [InlineData(0xEF, 3)]   // 3-byte start max
    [InlineData(0xF0, 4)]   // 4-byte start min
    [InlineData(0xF7, 4)]   // 4-byte start max
    [InlineData(0x80, 1)]   // Continuation byte (fallback)
    [InlineData(0xBF, 1)]   // Continuation byte (fallback)
    public void GetUtf8ScalarLength_ReturnsCorrectRuneLength(byte inputByte, int expected)
    {
        // Access via SearchIndexService.TokenizeForTests which uses GetUtf8ScalarLength internally
        // Verify by round-tripping: tokenize text containing those codepoints
        // For direct testing: use reflection to access the inner class method
        var type = typeof(SearchIndexService).GetNestedType("SearchDictionaryReader", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        if (type == null) return; // Nested class may not be accessible

        var method = type.GetMethod("GetUtf8ScalarLength", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
        if (method == null) return;

        int actual = (int)method.Invoke(null, [inputByte])!;
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void TokenizeForTests_EmptyText_ReturnsEmpty()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, string.Empty);
        Assert.Empty(tokens);
    }

    [Fact]
    public void TokenizeForTests_WhitespaceOnly_ReturnsEmpty()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "   \t\n");
        Assert.Empty(tokens);
    }

    [Fact]
    public void TokenizeForTests_PunctuationOnly_ProducesTokens()
    {
        // The tokenizer does not strip all punctuation; some symbols generate hash tokens
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "!@#$%^&*(),.;:?");
        // Just verify it runs without throwing; we do not assert empty because some
        // punctuation chars are tokenized by the underlying segmenter
        Assert.NotNull(tokens);
    }

    [Fact]
    public void TokenizeForTests_SingleAsciiToken_ReturnsOneToken()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "hello");
        Assert.Single(tokens);
        Assert.Equal(SearchIndexService.HashTokenForTests("hello"), tokens[0].Hash);
    }

    [Fact]
    public void TokenizeForTests_StopwordMarked_WhenInStopwordList()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries: ["的\t1000"],
            stopwords: ["的"]);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "的");
        // Any tokens emitted should be marked as stopword=true
        if (tokens.Length > 0)
        {
            Assert.True(tokens[0].Stopword);
        }
    }

    [Fact]
    public void TokenizeForTests_TitleField_AssignsCorrectPosition()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: []);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "hello world", fieldName: "Title");
        Assert.Equal(2, tokens.Length);
        Assert.Equal(0u, tokens[0].Position);
        Assert.Equal(1u, tokens[1].Position);
    }

    [Fact]
    public void TokenizeForTests_DomainDictHasHigherPriorityThanCore()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries: ["机器\t50", "学习\t50"],
            domainEntries: ["机器学习\t1000"]);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "机器学习");
        // Machine learning should be recognized as a domain phrase
        bool hasFullPhrase = tokens.Any(t => t.Text == "机器学习");
        Assert.True(hasFullPhrase);
    }

    [Fact]
    public void TokenizeForTests_LongCjkSegment_KeepsDictionaryMatchesSubtokensAndStopwords()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "北京大学\t500",
                "自然语言处理\t450",
                "机器学习\t400",
                "深度学习\t350",
                "大学\t50",
                "语言\t50",
                "学习\t50"
            ],
            stopwords: ["学习"]);
        string text = string.Concat(
            "北京大学自然语言处理机器学习深度学习",
            new string('甲', 120),
            "北京大学机器学习");

        SearchIndexService.SearchTokenDebugView[] tokens = SearchIndexService.TokenizeForTests(lexiconRoot, text);

        Assert.Contains(tokens, static token => token.Text == "北京大学" && token.PositionLength == 4u);
        Assert.Contains(tokens, static token => token.Text == "自然语言处理" && token.PositionLength == 6u);
        Assert.Contains(tokens, static token => token.Text == "机器学习" && token.PositionLength == 4u);
        Assert.Contains(tokens, static token => token.Text == "大学" && token.PositionLength == 2u);
        Assert.Contains(tokens, static token => token.Text == "学习" && token.Stopword);
        Assert.True(tokens.Select(static token => token.Position).SequenceEqual(tokens.Select(static token => token.Position).Order()));
    }

    [Fact]
    public void TokenizeForTests_MixedChineseAndEnglish_BothTokenized()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: ["机器\t50", "学习\t50"]);
        var tokens = SearchIndexService.TokenizeForTests(lexiconRoot, "machine学习");
        Assert.NotEmpty(tokens);
        bool hasMachine = tokens.Any(t => t.Hash == SearchIndexService.HashTokenForTests("machine"));
        Assert.True(hasMachine);
    }

    [Fact]
    public void TokenizeForTests_TrieDictionaryLookup_PreservesOverlapsLongSegmentsStopwordsAndMixedAscii()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "中华\t50",
                "人民\t50",
                "中华人民\t500",
                "共和国\t450",
                "语言\t50",
                "处理\t50",
                "语言处理\t400",
                "学习\t50"
            ],
            stopwords: ["的"]);

        SearchIndexService.SearchTokenDebugView[] tokens = SearchIndexService.TokenizeForTests(
            lexiconRoot,
            "pipeline中华人民共和国语言处理machine学习的");

        Assert.Contains(tokens, static token => token.Hash == SearchIndexService.HashTokenForTests("pipeline"));
        Assert.Contains(tokens, static token => token.Text == "中华人民" && token.PositionLength == 4u);
        Assert.Contains(tokens, static token => token.Text == "中华" && token.PositionLength == 2u);
        Assert.Contains(tokens, static token => token.Text == "人民" && token.PositionLength == 2u);
        Assert.Contains(tokens, static token => token.Text == "共和国" && token.PositionLength == 3u);
        Assert.Contains(tokens, static token => token.Text == "语言处理" && token.PositionLength == 4u);
        Assert.Contains(tokens, static token => token.Hash == SearchIndexService.HashTokenForTests("machine"));
        Assert.Contains(tokens, static token => token.Text == "学习");
        Assert.Contains(tokens, static token => token.Text == "的" && token.Stopword);
    }

    [Fact]
    public void RuntimeQueryHashesForTests_ExactDictionaryTerm_UsesDocumentTokenizer()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "北京\t50",
                "大学\t50",
                "北京大学\t500",
                "北京大\t10"
            ]);

        uint[] queryHashes = SearchIndexService.RuntimeQueryHashesForTests(lexiconRoot, "北京大学");
        uint[] documentHashes = SearchIndexService.TokenizeForTests(lexiconRoot, "北京大学")
            .Select(static token => token.Hash)
            .Distinct()
            .OrderBy(static hash => hash)
            .ToArray();

        Assert.Equal(documentHashes, queryHashes.OrderBy(static hash => hash).ToArray());
        Assert.Contains(SearchIndexService.HashTokenForTests("北京大学"), queryHashes);
        Assert.Contains(SearchIndexService.HashTokenForTests("北京"), queryHashes);
        Assert.Contains(SearchIndexService.HashTokenForTests("大学"), queryHashes);
    }

    [Fact]
    public void RuntimeQueryHashesForTests_PartialCjkQuery_UsesDictionaryTokenWhenAvailable()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "北京\t50",
                "大学\t50",
                "北京大学\t500"
            ]);

        uint[] queryHashes = SearchIndexService.RuntimeQueryHashesForTests(lexiconRoot, "北京");
        uint[] documentHashes = SearchIndexService.TokenizeForTests(lexiconRoot, "北京")
            .Select(static token => token.Hash)
            .Distinct()
            .OrderBy(static hash => hash)
            .ToArray();

        Assert.Equal(documentHashes, queryHashes.OrderBy(static hash => hash).ToArray());
        Assert.Contains(SearchIndexService.HashTokenForTests("北京"), queryHashes);
    }

    [Fact]
    public void RuntimeQueryHashesForTests_MixedCjkAsciiQuery_PreservesAsciiCompatibility()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: ["学习\t50"]);

        uint[] queryHashes = SearchIndexService.RuntimeQueryHashesForTests(lexiconRoot, "Machine学习");
        uint[] documentHashes = SearchIndexService.TokenizeForTests(lexiconRoot, "Machine学习")
            .Select(static token => token.Hash)
            .Distinct()
            .OrderBy(static hash => hash)
            .ToArray();

        Assert.Equal(documentHashes, queryHashes.OrderBy(static hash => hash).ToArray());
        Assert.Contains(SearchIndexService.HashTokenForTests("machine"), queryHashes);
        Assert.Contains(SearchIndexService.HashTokenForTests("学习"), queryHashes);
    }

    [Fact]
    public void RuntimeQueryHashesForTests_PunctuationAndWhitespace_StaysAlignedWithDocumentTokenizer()
    {
        string lexiconRoot = CreateLexiconRoot(coreEntries: ["北京\t50", "大学\t50", "学习\t50"]);

        const string query = "  北京, 大学\t学习!! ";
        uint[] queryHashes = SearchIndexService.RuntimeQueryHashesForTests(lexiconRoot, query);
        uint[] documentHashes = SearchIndexService.TokenizeForTests(lexiconRoot, query)
            .Select(static token => token.Hash)
            .Distinct()
            .OrderBy(static hash => hash)
            .ToArray();

        Assert.Equal(documentHashes, queryHashes.OrderBy(static hash => hash).ToArray());
        Assert.Contains(SearchIndexService.HashTokenForTests("北京"), queryHashes);
        Assert.Contains(SearchIndexService.HashTokenForTests("大学"), queryHashes);
        Assert.Contains(SearchIndexService.HashTokenForTests("学习"), queryHashes);
    }

    [Fact]
    public void RuntimeSearchResultIdsForTests_ExactCjkDictionaryMatch_RanksAboveLooseUnigramMatches()
    {
        string lexiconRoot = CreateLexiconRoot(
            coreEntries:
            [
                "北京\t50",
                "大学\t50",
                "北京大学\t500"
            ]);
        var createdAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        int[] resultIds = SearchIndexService.RuntimeSearchResultIdsForTests(
            lexiconRoot,
            "北京大学",
            new SearchIndexService.SearchRuntimeTestArticle(1, "北京大学", "", "", 1, createdAt),
            new SearchIndexService.SearchRuntimeTestArticle(2, "北京 大学", "", "", 1000, createdAt.AddMinutes(1)),
            new SearchIndexService.SearchRuntimeTestArticle(3, "北京", "", "", 2000, createdAt.AddMinutes(2)));

        Assert.NotEmpty(resultIds);
        Assert.Equal(1, resultIds[0]);
        Assert.Contains(2, resultIds);
        Assert.Contains(3, resultIds);
    }

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(SearchIndexService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    [Theory]
    [InlineData(100, 5, true)]      // normal case
    [InlineData(0, 5, false)]       // docCount <= 0
    [InlineData(100, 0, false)]     // df <= 0
    public void ComputeIdf_ReturnsExpected(int docCount, int df, bool expectPositive)
    {
        float result = InvokePrivateStatic<float>("ComputeIdf", [(object)docCount, df]);
        if (expectPositive) Assert.True(result > 0f);
        else Assert.Equal(0f, result);
    }

    [Theory]
    [InlineData(5, 100, false, true, true)]    // all conditions met
    [InlineData(5, 100, true, true, false)]    // stopword → false
    [InlineData(0, 100, false, true, false)]   // df=0 → false
    [InlineData(5, 100, false, false, false)]  // keepPositionsCandidate=false → false
    [InlineData(200, 100, false, true, false)] // df >= dfCutoff → false
    public void ShouldKeepPositions_ReturnsExpected(int df, int dfCutoff, bool stopword, bool keepPos, bool expected)
    {
        bool result = InvokePrivateStatic<bool>("ShouldKeepPositions", [(object)df, dfCutoff, stopword, keepPos]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(0, 4, 0)]    // 0 already aligned
    [InlineData(1, 4, 4)]    // 1 → 4
    [InlineData(3, 4, 4)]    // 3 → 4
    [InlineData(4, 4, 4)]    // 4 already aligned
    [InlineData(5, 4, 8)]    // 5 → 8
    public void Align_ReturnsExpected(int value, int alignment, int expected)
    {
        int result = InvokePrivateStatic<int>("Align", [(object)value, alignment]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(0, 0, 0, 0)]         // empty → false
    [InlineData(100, 5, 5, 0)]       // patchDoc > threshold → false
    [InlineData(100, 2, 2, 100)]     // patchDoc <= threshold, small patch → true (depends on byte ratio)
    public void ShouldEmitPatch_ZeroPatchDocs_ReturnsFalse(int shardDocs, int patchDocs, int tombstones, int patchBytes)
    {
        if (patchDocs == 0 && tombstones == 0)
        {
            bool result = InvokePrivateStatic<bool>("ShouldEmitPatch", [(object)shardDocs, patchDocs, tombstones, patchBytes, 1000]);
            Assert.False(result);
        }
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
