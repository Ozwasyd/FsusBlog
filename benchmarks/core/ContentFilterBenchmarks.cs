using System.Buffers;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

using BenchmarkDotNet.Attributes;

using FsusBlog.Server.Infrastructure.Helpers.Security;

using Microsoft.Extensions.Logging.Abstractions;

[MemoryDiagnoser]
public partial class ContentFilterHotPathBenchmarks
{
    private static readonly string[] s_contactRules =
    [
        "加v", "加微", "加威", "加薇", "加嶶", "vx", "微信", "威信", "薇信", "+v", "qq", "扣扣", "企鹅", "q群", "加群"
    ];

    private static readonly string[] s_adRules =
    [
        "广告关键词",
        "恶意链接",
        "优惠+推广"
    ];

    private static readonly string[] s_sensitiveRules =
    [
        "违禁词汇",
        "敏感关键词",
        "风险+内容"
    ];

    private static readonly string[] s_topRedLineRules =
    [
        "习+近+平",
        "毛+泽+东",
        "六+四+事+件"
    ];

    private readonly ModernAcAutomaton _legacyContactSearch = new();
    private readonly ModernAcAutomaton _legacyAdSearch = new();
    private readonly ModernAcAutomaton _legacySensitiveSearch = new();
    private readonly ModernTaggedAcAutomaton<int> _unifiedSearch = new();

    private string _text = string.Empty;

    [Params("short", "medium", "long")]
    public string CommentSize { get; set; } = "short";

    [GeneratedRegex(@"(习.{0,6}近.{0,6}平|毛.{0,6}泽.{0,6}东|六.{0,6}四.{0,6}事.{0,6}件)", RegexOptions.IgnoreCase)]
    private static partial Regex LegacyTopRedLineRegex();

    [GlobalSetup]
    public void Setup()
    {
        TextNormalizer.Initialize(NullLogger.Instance);

        _legacyContactSearch.Build(NormalizeKeywords(s_contactRules));
        _legacyAdSearch.Build(NormalizeKeywords(s_adRules));
        _legacySensitiveSearch.Build(NormalizeKeywords(s_sensitiveRules));

        var unifiedRules = new List<ModernTaggedAcRule<int>>();
        AddRules(unifiedRules, s_contactRules, 1, 0);
        AddRules(unifiedRules, s_adRules, 2, 1);
        AddRules(unifiedRules, s_topRedLineRules, 3, 2);
        AddRules(unifiedRules, s_sensitiveRules, 4, 3);
        _unifiedSearch.Build(CollectionsMarshal.AsSpan(unifiedRules));

        _text = CommentSize switch
        {
            "short" => "这是一条正常评论",
            "medium" => string.Join(' ', Enumerable.Repeat("这是一段包含多个普通词的评论内容用于模拟中等长度输入", 8)),
            _ => string.Join(' ', Enumerable.Repeat("这是一段包含多个普通词的评论内容用于模拟长评论输入并触发完整扫描路径", 64))
        };
    }

    [Benchmark(Baseline = true)]
    public int LegacyMultiScan()
    {
        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(_text.Length);
            Span<char> bufferSpan = rentedBuffer.AsSpan(0, _text.Length);
            _text.AsSpan().CopyTo(bufferSpan);
            TextNormalizer.NormalizeInPlace(bufferSpan);

            if (_legacyContactSearch.ContainsAny(bufferSpan))
            {
                return 1;
            }

            if (_legacyAdSearch.ContainsAny(bufferSpan))
            {
                return 2;
            }

            if (LegacyTopRedLineRegex().IsMatch(bufferSpan))
            {
                return 3;
            }

            return _legacySensitiveSearch.ContainsAny(bufferSpan) ? 4 : 0;
        }
        finally
        {
            if (rentedBuffer != null)
            {
                ArrayPool<char>.Shared.Return(rentedBuffer);
            }
        }
    }

    [Benchmark]
    public int UnifiedTaggedScan()
    {
        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(_text.Length);
            Span<char> bufferSpan = rentedBuffer.AsSpan(0, _text.Length);
            _text.AsSpan().CopyTo(bufferSpan);
            TextNormalizer.NormalizeInPlace(bufferSpan);

            return _unifiedSearch.TryFindBest(bufferSpan, out int payload) ? payload : 0;
        }
        finally
        {
            if (rentedBuffer != null)
            {
                ArrayPool<char>.Shared.Return(rentedBuffer);
            }
        }
    }

    private static void AddRules(List<ModernTaggedAcRule<int>> rules, string[] patterns, int payload, int priority)
    {
        foreach (string pattern in patterns)
        {
            rules.Add(new ModernTaggedAcRule<int>(pattern, payload, priority));
        }
    }

    private static string[] NormalizeKeywords(string[] keywords)
    {
        int maxLength = keywords.Length == 0 ? 0 : keywords.Max(static keyword => keyword.Length);
        if (maxLength == 0)
        {
            return [];
        }

        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(maxLength);
            var normalized = new string[keywords.Length];
            for (int i = 0; i < keywords.Length; i++)
            {
                string keyword = keywords[i];
                Span<char> bufferSpan = rentedBuffer.AsSpan(0, keyword.Length);
                keyword.AsSpan().CopyTo(bufferSpan);
                TextNormalizer.NormalizeInPlace(bufferSpan);
                normalized[i] = bufferSpan.ToString();
            }

            return normalized;
        }
        finally
        {
            if (rentedBuffer != null)
            {
                ArrayPool<char>.Shared.Return(rentedBuffer);
            }
        }
    }
}
