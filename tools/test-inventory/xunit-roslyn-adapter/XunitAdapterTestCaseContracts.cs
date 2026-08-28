internal static partial class XunitAdapterProgram
{
    public sealed class TestCase
    {
        public string Id { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public string Kind { get; init; } = "";
        public string Identity { get; init; } = "static";
        public string OwnerFile { get; init; } = "";
        public string OwnerClass { get; init; } = "";
        public string OwnerSuite { get; init; } = "";
        public string MethodName { get; init; } = "";
        public string Adapter { get; init; } = AdapterId;
        public Span SourceSpan { get; init; } = new();
        public Span? BodySpan
        {
            get; init;
        }
        public string? BodySource
        {
            get; init;
        }
        public List<Trait> Traits { get; init; } = new();
        public string? Category
        {
            get; init;
        }
        public string? Platform
        {
            get; init;
        }
        public string? Fixture
        {
            get; init;
        }
        public string? SkipReason
        {
            get; init;
        }
        public bool Explicit
        {
            get; init;
        }
        public int? TimeoutMs
        {
            get; init;
        }
        public DynamicCaseInfo? DynamicCaseInfo
        {
            get; init;
        }
        public MethodFacts MethodFacts { get; init; } = new();
    }
}
