using BenchmarkDotNet.Attributes;
using FsusBlog.Server.Infrastructure.Helpers.Security;

[MemoryDiagnoser]
public class CompositeAcBenchmarks
{
    private ModernAcAutomaton _automaton = new();
    private string _noComponentHit = string.Empty;
    private string _partialComponentHit = string.Empty;
    private string _completedRuleHit = string.Empty;

    [Params(128, 1024, 4096)]
    public int CompositeRuleCount { get; set; }

    [GlobalSetup]
    public void Setup()
    {
        string[] rules = Enumerable
            .Range(0, CompositeRuleCount)
            .Select(static i => $"shared{i % 32}+tail{i}")
            .ToArray();
        _automaton = new ModernAcAutomaton();
        _automaton.Build(rules);

        _noComponentHit = string.Join(' ', Enumerable.Repeat("clean text without indexed components", 32));
        _partialComponentHit = string.Join(' ', Enumerable.Repeat("shared7 appears many times", 32));
        int completedRuleId = Enumerable.Range(0, CompositeRuleCount).Last(static i => i % 32 == 7);
        _completedRuleHit = $"prefix shared7 middle tail{completedRuleId} suffix";
    }

    [Benchmark(Baseline = true)]
    public bool NoComponentHit()
        => _automaton.ContainsAny(_noComponentHit);

    [Benchmark]
    public bool PartialSharedComponentHit()
        => _automaton.ContainsAny(_partialComponentHit);

    [Benchmark]
    public bool CompletedRuleHit()
        => _automaton.ContainsAny(_completedRuleHit);
}
