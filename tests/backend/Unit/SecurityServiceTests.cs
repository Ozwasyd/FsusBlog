using System.Net;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// ModernAcAutomaton — core AC automaton tests
// ──────────────────────────────────────────────────────────────────────────────

public class ModernAcAutomatonTests
{
    [Fact]
    public void Build_EmptyKeywords_ContainsAnyReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build([]);
        Assert.False(ac.ContainsAny("test text"));
    }

    [Fact]
    public void Build_NullKeywords_ContainsAnyReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(null!);
        Assert.False(ac.ContainsAny("test"));
    }

    [Fact]
    public void ContainsAny_EmptyText_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["hello"]);
        Assert.False(ac.ContainsAny(string.Empty));
    }

    [Fact]
    public void ContainsAny_ExactMatch_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["forbidden"]);
        Assert.True(ac.ContainsAny("this text contains forbidden word"));
    }

    [Fact]
    public void ContainsAny_NotPresent_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["forbidden"]);
        Assert.False(ac.ContainsAny("this text is clean"));
    }

    [Fact]
    public void ContainsAny_MultipleKeywords_MatchesAny()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["aaa", "bbb", "ccc"]);
        Assert.True(ac.ContainsAny("text with bbb inside"));
    }

    [Fact]
    public void ContainsAny_KeywordAtStart_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["start"]);
        Assert.True(ac.ContainsAny("start of text"));
    }

    [Fact]
    public void ContainsAny_KeywordAtEnd_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["end"]);
        Assert.True(ac.ContainsAny("text at end"));
    }

    [Fact]
    public void ContainsAny_AndRule_BothPresent_ReturnsTrue()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta"]);
        Assert.True(ac.ContainsAny("alpha and beta are both here"));
    }

    [Fact]
    public void ContainsAny_AndRule_OnlyOnePresent_ReturnsFalse()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta"]);
        Assert.False(ac.ContainsAny("only alpha here"));
    }

    [Fact]
    public void ContainsAny_AndRule_RepeatedComponentOccurrencesCountOnce()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta"]);

        Assert.False(ac.ContainsAny("alpha alpha alpha"));
        Assert.True(ac.ContainsAny("alpha alpha beta"));
    }

    [Fact]
    public void ContainsAny_AndRule_SharedComponentRulesOnlyMatchCompletedRule()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["alpha+beta", "alpha+gamma"]);

        Assert.True(ac.ContainsAny("gamma appears after alpha"));
        Assert.False(ac.ContainsAny("alpha appears without the other components"));
    }

    [Fact]
    public void TryFindBest_TaggedAndRule_PreservesPriorityWithSharedComponents()
    {
        for (int iteration = 0; iteration < 8; iteration++)
        {
            var ac = new ModernTaggedAcAutomaton<string>();
            ac.Build(
            [
                new ModernTaggedAcRule<string>("alpha+beta", "low", 3),
                new ModernTaggedAcRule<string>("alpha+gamma", "high", 1),
                new ModernTaggedAcRule<string>("delta", "single", 2)
            ]);

            Assert.True(ac.TryFindBest("alpha beta gamma", out string? payload));
            Assert.Equal("high", payload);
            Assert.True(ac.TryFindBest("alpha beta", out payload));
            Assert.Equal("low", payload);
        }
    }

    [Fact]
    public void ContainsAny_DuplicateKeywords_DeduplicatesGracefully()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["dup", "dup", "dup"]);
        Assert.True(ac.ContainsAny("dup"));
    }

    [Fact]
    public void ContainsAny_WideNodeMatchesViaDoubleArrayTransition()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["aa", "ab", "ac", "ad", "ae", "af", "ag"]);

        Assert.True(ac.ContainsAny("prefix ag suffix"));
        Assert.False(ac.ContainsAny("prefix az suffix"));
    }

    [Fact]
    public void ContainsAny_SuffixHeavyAsciiPatterns_UsesOutputLinks()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["a", "ba", "cba", "dcba"]);

        Assert.True(ac.ContainsAny("xxdcba"));
        Assert.True(ac.ContainsAny("xxcba"));
        Assert.True(ac.ContainsAny("xxba"));
        Assert.True(ac.ContainsAny("xxa"));
        Assert.False(ac.ContainsAny("zz"));
    }

    [Fact]
    public void ContainsAny_SuffixHeavyChinesePatterns_UsesOutputLinks()
    {
        var ac = new ModernAcAutomaton();
        ac.Build(["学", "大学", "北京大学", "清华北京大学"]);

        Assert.True(ac.ContainsAny("我在清华北京大学旁边"));
        Assert.True(ac.ContainsAny("我在北京大学旁边"));
        Assert.True(ac.ContainsAny("这是一所大学"));
        Assert.True(ac.ContainsAny("数学"));
        Assert.False(ac.ContainsAny("普通文本"));
    }

    [Fact]
    public void Build_RandomDictionary_PreservesSortedChildInvariantAndMatchesNaiveRules()
    {
        string[] words = ["甲", "乙", "丙", "丁", "北京", "大学", "算法", "缓存", "redis", "pow", "search", "artifact"];
        string[] rules =
        [
            "北京+大学",
            "缓存+redis",
            "pow",
            "search",
            "artifact",
            "甲乙",
            "丙丁"
        ];
        var random = new Random(20260531);
        var generatedRules = new List<string>(rules);
        for (int i = 0; i < 64; i++)
        {
            string first = words[random.Next(words.Length)];
            string second = words[random.Next(words.Length)];
            generatedRules.Add(random.Next(2) == 0 ? string.Concat(first, second) : string.Concat(first, "+", second));
        }

        var ac = new ModernAcAutomaton();
        ac.Build([.. generatedRules]);

        Assert.True(ac.ValidateSortedChildRangesForTests());
        for (int i = 0; i < 128; i++)
        {
            string text = string.Concat(
                words[random.Next(words.Length)],
                words[random.Next(words.Length)],
                words[random.Next(words.Length)]);

            Assert.Equal(NaiveContains(generatedRules, text), ac.ContainsAny(text));
        }
    }

    [Fact]
    public void ContainsAny_ConcurrentCompositeScans_MatchNaiveRules()
    {
        string[] rules =
        [
            "alpha+beta",
            "alpha+gamma",
            "缓存+redis",
            "pow",
            "北京+大学",
            "delta"
        ];
        string[] texts =
        [
            "alpha only",
            "beta then alpha",
            "gamma with alpha",
            "缓存命中 redis",
            "普通文本",
            "北京理工大学",
            "pow challenge",
            "delta"
        ];
        var ac = new ModernAcAutomaton();
        ac.Build(rules);
        int mismatches = 0;

        Parallel.For(0, Environment.ProcessorCount * 512, i =>
        {
            string text = texts[i % texts.Length];
            bool expected = NaiveContains(rules, text);
            if (ac.ContainsAny(text) != expected)
            {
                Interlocked.Increment(ref mismatches);
            }
        });

        Assert.Equal(0, mismatches);
    }

    [Fact]
    public void ModernAcAutomaton_UsesCompactDoubleArrayTransitionsInRuntimeShape()
    {
        Type type = typeof(ModernAcAutomaton);
        Dictionary<string, Type> fields = type.GetFields(BindingFlags.NonPublic | BindingFlags.Instance)
            .ToDictionary(static field => field.Name, static field => field.FieldType, StringComparer.Ordinal);
        Assert.Equal(typeof(int[]), fields["_base"]);
        Assert.Equal(typeof(int[]), fields["_check"]);
        Assert.Equal(typeof(int[]), fields["_outputLink"]);
        Assert.Equal(typeof(int[]), fields["_alphabetMap"]);
        Assert.NotNull(type.GetMethod("NextState", BindingFlags.NonPublic | BindingFlags.Instance));
        Assert.Null(type.GetMethod("FindChildFast", BindingFlags.NonPublic | BindingFlags.Instance));
        Assert.DoesNotContain(fields.Keys, static name =>
            name.Contains("ChildrenOffset", StringComparison.Ordinal)
            || name.Contains("ChildrenCount", StringComparison.Ordinal)
            || name.Contains("Legacy", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ModernAcAutomaton_CompositeMatchingUsesInvertedIndexInHotScan()
    {
        Type type = typeof(ModernAcAutomaton);
        Assert.Equal(typeof(int[]), type.GetField("_componentRuleOffsets", BindingFlags.NonPublic | BindingFlags.Instance)?.FieldType);
        Assert.Equal(typeof(int[]), type.GetField("_componentRuleIds", BindingFlags.NonPublic | BindingFlags.Instance)?.FieldType);

        MethodInfo containsAny = type.GetMethod(nameof(ModernAcAutomaton.ContainsAny))!;
        MethodInfo processMatches = type.GetMethod("ProcessMatches", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Composite match processor was not found.");
        MethodInfo markComponent = type.GetMethod("TryMarkCompositeComponent", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Composite component marker was not found.");
        Assert.Contains(ReadCalledMethods(containsAny), method => method == processMatches);
        Assert.Contains(ReadCalledMethods(processMatches), method => method == markComponent);
        FieldInfo[] invertedIndexFields = ReadReferencedFields(markComponent).ToArray();
        Assert.Contains(invertedIndexFields, static field => field.Name == "_componentRuleOffsets");
        Assert.Contains(invertedIndexFields, static field => field.Name == "_componentRuleIds");
    }

    private static bool NaiveContains(IEnumerable<string> rules, string text)
    {
        foreach (string rule in rules)
        {
            string[] parts = rule
                .Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 0)
            {
                continue;
            }

            if (parts.All(part => text.Contains(part, StringComparison.Ordinal)))
            {
                return true;
            }
        }

        return false;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
        => ReadMemberTokens(method, [0x28, 0x6F]).OfType<MethodBase>();

    private static IEnumerable<FieldInfo> ReadReferencedFields(MethodInfo method)
        => ReadMemberTokens(method, [0x7B, 0x7C, 0x7D, 0x7E, 0x7F, 0x80]).OfType<FieldInfo>();

    private static IEnumerable<MemberInfo> ReadMemberTokens(MethodInfo method, byte[] opcodes)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (!opcodes.Contains(il[offset]))
            {
                continue;
            }

            MemberInfo? member = null;
            try
            {
                member = method.Module.ResolveMember(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
            }
            catch (ArgumentException)
            {
            }
            if (member is not null)
            {
                yield return member;
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CrawlerDetectorService
// ──────────────────────────────────────────────────────────────────────────────

public class CrawlerDetectorServiceTests
{
    private static CrawlerDetectorService CreateService()
    {
        var cache = new MemoryCache(new MemoryCacheOptions());
        return new CrawlerDetectorService(NullLogger<CrawlerDetectorService>.Instance, cache);
    }

    [Fact]
    public async Task IsVerifiedCrawler_EmptyIp_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("", "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_EmptyUserAgent_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("66.249.64.1", "");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_TooLongIp_ReturnsFalse()
    {
        var svc = CreateService();
        string longIp = new('1', 65);
        bool result = await svc.IsVerifiedCrawlerAsync(longIp, "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_InvalidIp_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("not.an.ip", "Googlebot/2.1");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotWithoutCidr_ReturnsFalse()
    {
        var svc = CreateService();
        // No CIDR loaded, so even a Googlebot IP will fail the tree match
        bool result = await svc.IsVerifiedCrawlerAsync("66.249.64.1", "Mozilla/5.0 (compatible; Googlebot/2.1)");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_UnknownBot_ReturnsFalse()
    {
        var svc = CreateService();
        bool result = await svc.IsVerifiedCrawlerAsync("1.2.3.4", "SomeOtherBot/1.0");
        Assert.False(result);
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotInRegisteredCidr_ReturnsTrue()
    {
        const string GooglebotUserAgent = "Mozilla/5.0 (compatible; Googlebot/2.1)";
        const string BingbotUserAgent = "Mozilla/5.0 (compatible; bingbot/2.0)";
        var svc = CreateService();
        svc.UpdateCidrLists(
            ["66.249.64.0/24", "64.233.160.0/24"],
            ["40.77.0.0/24"]);

        Assert.True(await svc.IsVerifiedCrawlerAsync("66.249.64.1", GooglebotUserAgent));
        Assert.True(await svc.IsVerifiedCrawlerAsync("64.233.160.254", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("66.249.65.1", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("66.249.64.1", BingbotUserAgent));
    }

    [Fact]
    public async Task IsVerifiedCrawler_BingbotInRegisteredCidr_ReturnsTrue()
    {
        const string GooglebotUserAgent = "Mozilla/5.0 (compatible; Googlebot/2.1)";
        const string BingbotUserAgent = "Mozilla/5.0 (compatible; bingbot/2.0)";
        var svc = CreateService();
        svc.UpdateCidrLists(
            ["66.249.64.0/24"],
            ["40.77.0.0/24"]);

        Assert.True(await svc.IsVerifiedCrawlerAsync("40.77.0.1", BingbotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("40.77.1.1", BingbotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("40.77.0.1", GooglebotUserAgent));
    }

    [Fact]
    public async Task IsVerifiedCrawler_GooglebotOutsideCidr_ReturnsFalse()
    {
        var svc = CreateService();
        svc.UpdateCidrLists(["66.249.64.0/19"], []);
        bool result = await svc.IsVerifiedCrawlerAsync("1.2.3.4", "Mozilla/5.0 (compatible; Googlebot/2.1)");
        Assert.False(result);
    }

    [Fact]
    public async Task UpdateCidrLists_WithInvalidCidrEntries_SkipsInvalidAndReplacesPreviousSnapshot()
    {
        const string GooglebotUserAgent = "Mozilla/5.0 (compatible; Googlebot/2.1)";
        const string BingbotUserAgent = "Mozilla/5.0 (compatible; bingbot/2.0)";
        var svc = CreateService();
        svc.UpdateCidrLists(["66.249.64.0/24"], []);
        Assert.True(await svc.IsVerifiedCrawlerAsync("66.249.64.1", GooglebotUserAgent));

        svc.UpdateCidrLists(
            ["", "198.51.100.0", "203.0.113.0/33", "192.0.2.0/24"],
            ["", "40.77.0.0", "bad/bad"]);

        Assert.True(await svc.IsVerifiedCrawlerAsync("192.0.2.25", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("66.249.64.1", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("198.51.100.1", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("203.0.113.1", GooglebotUserAgent));
        Assert.False(await svc.IsVerifiedCrawlerAsync("40.77.0.1", BingbotUserAgent));
    }
}
