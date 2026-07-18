using BenchmarkDotNet.Attributes;

using FsusBlog.Server.Infrastructure.Helpers.Security;

[MemoryDiagnoser]
public class DoubleArrayAcBenchmarks
{
    private string[] _rules = [];
    private string _text = string.Empty;
    private ModernAcAutomaton _automaton = new();

    [Params("small-contact", "medium-ad", "large-sensitive", "adversarial-failure")]
    public string Scenario { get; set; } = "small-contact";

    [GlobalSetup]
    public void Setup()
    {
        (_rules, _text) = Scenario switch
        {
            "small-contact" => CreateSmallContactScenario(),
            "medium-ad" => CreateMediumAdScenario(),
            "large-sensitive" => CreateLargeSensitiveScenario(),
            "adversarial-failure" => CreateAdversarialFailureScenario(),
            _ => CreateSmallContactScenario()
        };

        _automaton = BuildAutomaton();
    }

    [Benchmark]
    public ModernAcAutomaton Build()
        => BuildAutomaton();

    [Benchmark]
    public bool Scan()
        => _automaton.ContainsAny(_text);

    private ModernAcAutomaton BuildAutomaton()
    {
        var automaton = new ModernAcAutomaton();
        automaton.Build(_rules);
        return automaton;
    }

    private static (string[] Rules, string Text) CreateSmallContactScenario()
        =>
        (
            [
                "加v", "加微", "加威", "vx", "微信", "威信", "qq", "扣扣", "企鹅", "q群", "加群", "+v"
            ],
            string.Join(' ', Enumerable.Repeat("这是一条正常评论不会包含联系方式", 64))
        );

    private static (string[] Rules, string Text) CreateMediumAdScenario()
    {
        string[] rules = Enumerable.Range(0, 512)
            .Select(static i => $"广告{i:D3}+推广{i % 31:D2}")
            .Concat(Enumerable.Range(0, 512).Select(static i => $"优惠链接{i:D3}"))
            .ToArray();

        string text = string.Join(' ', Enumerable.Range(0, 512).Select(static i => $"普通内容片段{i:D3}"));
        return (rules, text);
    }

    private static (string[] Rules, string Text) CreateLargeSensitiveScenario()
    {
        string[] rules = Enumerable.Range(0, 8192)
            .Select(static i => $"敏感词{i:D5}")
            .Concat(Enumerable.Range(0, 2048).Select(static i => $"风险{i:D4}+内容{i % 257:D3}"))
            .ToArray();

        string text = string.Join(' ', Enumerable.Range(0, 1024).Select(static i => $"正常文本{i:D5}"));
        return (rules, text);
    }

    private static (string[] Rules, string Text) CreateAdversarialFailureScenario()
    {
        string[] rules = Enumerable.Range(1, 256)
            .Select(static i => string.Concat(Enumerable.Repeat("a", i)) + "b")
            .Concat(["a", "ba", "cba", "dcba", "大学", "北京大学", "清华北京大学"])
            .ToArray();

        string text = string.Concat(Enumerable.Repeat("a", 8192)) + "c";
        return (rules, text);
    }
}
