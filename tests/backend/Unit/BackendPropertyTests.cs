using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Property")]
public sealed class BackendPropertyTests
{
    private const string Source = "tests/backend/Unit/BackendPropertyTests.cs";

    [Fact]
    public void AedsRoundTripProperty_PreservesPayloadAndFrameType()
    {
        var cases = new List<string>();
        var encoder = new AedsEncoder();
        AedsFrameType[] frameTypes = Enum.GetValues<AedsFrameType>()
            .Where(static frameType =>
                frameType != AedsFrameType.Unknown
                && !frameType.ToString().StartsWith("Retired", StringComparison.Ordinal))
            .ToArray();
        int seed = ReplaySeed(
            $"xunit:{Source}#AedsRoundTripProperty_PreservesPayloadAndFrameType",
            "backend-aeds-roundtrip-payloads");
        using var execution = BackendPropertyExecutionJournal.Open($"xunit:{Source}#{nameof(AedsRoundTripProperty_PreservesPayloadAndFrameType)}", "backend-aeds-roundtrip-payloads");

        foreach (AedsFrameType frameType in frameTypes)
        {
            foreach (byte[] payload in GeneratePayloads(unchecked((int)frameType + seed)))
            {
                execution.Observe($"{frameType}:{Convert.ToHexString(payload)}", cases.Count, () =>
                {
                    byte[] frame = encoder.Encode(frameType, payload);
                    var decoded = encoder.TryDecode(frame);

                    Assert.True(decoded.IsSuccess);
                    Assert.Equal(frameType, decoded.Value.FrameType);
                    Assert.Equal((uint)payload.Length, decoded.Value.Header.PayloadLength);
                    Assert.True(decoded.Value.Payload.Span.SequenceEqual(payload));
                    RecordCase(cases, $"{frameType}:{Convert.ToHexString(payload)}");
                });
            }
        }
        PublishExecution(nameof(AedsRoundTripProperty_PreservesPayloadAndFrameType), "backend-aeds-roundtrip-payloads", cases);
        execution.Complete(cases.Count);
    }

    [Fact]
    public void AedsTruncationProperty_ReturnsProtocolFailureInsteadOfThrowing()
    {
        var cases = new List<string>();
        var encoder = new AedsEncoder();
        int seed = ReplaySeed(
            $"xunit:{Source}#AedsTruncationProperty_ReturnsProtocolFailureInsteadOfThrowing",
            "backend-aeds-truncation-payloads");
        using var execution = BackendPropertyExecutionJournal.Open($"xunit:{Source}#{nameof(AedsTruncationProperty_ReturnsProtocolFailureInsteadOfThrowing)}", "backend-aeds-truncation-payloads");
        byte[] payload = GeneratePayloads(seed).Last();
        byte[] frame = encoder.Encode(AedsFrameType.ArticleDetail, payload);

        for (int length = 0; length < frame.Length; length++)
        {
            byte[] truncated = frame[..length];
            execution.Observe(Convert.ToHexString(truncated), cases.Count, () =>
            {
                var decoded = encoder.TryDecode(truncated);

                Assert.False(decoded.IsSuccess);
                RecordCase(cases, Convert.ToHexString(truncated));
            });
        }
        PublishExecution(nameof(AedsTruncationProperty_ReturnsProtocolFailureInsteadOfThrowing), "backend-aeds-truncation-payloads", cases);
        execution.Complete(cases.Count);
    }

    [Fact]
    public void AedsBitFlipProperty_DetectsPayloadCorruption()
    {
        var cases = new List<string>();
        var encoder = new AedsEncoder();
        int seed = ReplaySeed(
            $"xunit:{Source}#AedsBitFlipProperty_DetectsPayloadCorruption",
            "backend-aeds-bitflip-payloads");
        using var execution = BackendPropertyExecutionJournal.Open($"xunit:{Source}#{nameof(AedsBitFlipProperty_DetectsPayloadCorruption)}", "backend-aeds-bitflip-payloads");
        byte[] frame = encoder.Encode(AedsFrameType.ApiError, GeneratePayloads(seed).Last());

        for (int offset = AedsFrameHeader.Size; offset < frame.Length; offset += 3)
        {
            byte[] mutated = (byte[])frame.Clone();
            mutated[offset] ^= 0x5a;

            execution.Observe(Convert.ToHexString(mutated), cases.Count, () =>
            {
                var decoded = encoder.TryDecode(mutated);

                Assert.False(decoded.IsSuccess);
                RecordCase(cases, Convert.ToHexString(mutated));
            });
        }
        PublishExecution(nameof(AedsBitFlipProperty_DetectsPayloadCorruption), "backend-aeds-bitflip-payloads", cases);
        execution.Complete(cases.Count);
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

    private static void RecordCase(List<string> cases, string value)
    {
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes($"{cases.Count}:{value}");
        cases.Add($"sha256:{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes))}");
    }

    private static void PublishExecution(string method, string streamId, List<string> cases)
    {
        string? directory = Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_EXECUTION_DIR");
        if (directory is null)
        {
            return;
        }
        string RequireEnvironment(string name) => Environment.GetEnvironmentVariable(name)
            ?? throw new InvalidOperationException($"missing child execution identity: {name}");
        string canonicalTestId = $"xunit:{Source}#{method}";
        using var streams = System.Text.Json.JsonDocument.Parse(RequireEnvironment("FSUSBLOG_RANDOM_STREAMS_JSON"));
        var observation = new
        {
            canonicalTestId,
            streamId,
            derivedSeed = streams.RootElement.GetProperty($"{canonicalTestId}\0{streamId}").GetString(),
            runId = RequireEnvironment("FSUSBLOG_RANDOM_EXECUTION_RUN"),
            attemptId = RequireEnvironment("FSUSBLOG_RANDOM_EXECUTION_ATTEMPT"),
            replayPlanDigest = RequireEnvironment("FSUSBLOG_REPLAY_PLAN_DIGEST"),
            caseIdentities = cases,
            transitionIdentities = Array.Empty<string>(),
            outcome = "passed"
        };
        using var output = new FileStream(Path.Combine(directory, $"{streamId}.json"), FileMode.CreateNew, FileAccess.Write);
        System.Text.Json.JsonSerializer.Serialize(output, observation);
    }

    private static int ReplaySeed(string canonicalTestId, string streamId)
    {
        string document = Environment.GetEnvironmentVariable("FSUSBLOG_RANDOM_STREAMS_JSON")
            ?? throw new InvalidOperationException(
                "backend property correctness requires sealed FSUSBLOG_RANDOM_STREAMS_JSON");
        using var streams = System.Text.Json.JsonDocument.Parse(document);
        string key = $"{canonicalTestId}\0{streamId}";
        if (!streams.RootElement.TryGetProperty(key, out var value))
        {
            throw new InvalidOperationException($"backend property replay stream is missing: {streamId}");
        }
        string seed = value.GetString() ?? string.Empty;
        if (!seed.StartsWith("seed256:", StringComparison.Ordinal)
            || seed.Length != "seed256:".Length + 64)
        {
            throw new InvalidOperationException($"backend property replay stream is invalid: {streamId}");
        }
        uint value32 = uint.Parse(
            seed.AsSpan("seed256:".Length, 8),
            System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture);
        return unchecked((int)value32);
    }

}
