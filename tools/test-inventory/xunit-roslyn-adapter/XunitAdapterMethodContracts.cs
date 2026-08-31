internal static partial class XunitAdapterProgram
{
    public sealed class MethodFact
    {
        public string MethodName { get; init; } = "";
        public string ContainingType { get; init; } = "";
        public string Assembly { get; init; } = "";
        public string AssemblyKind { get; init; } = "";
        public bool CallsTestMethod
        {
            get; init;
        }
        public string? CalledTestMethodId
        {
            get; set;
        }
        public Span? Location
        {
            get; init;
        }
    }

    public sealed class MethodFacts
    {
        public List<MethodFact> Invocations { get; init; } = new();
        public List<MethodFact> AssertionCandidates { get; init; } = new();
        public List<string> ReturnStatements { get; init; } = new();
        public List<MethodFact> ProductionSymbolReferences { get; init; } = new();
        public List<MethodFact> TestAttributeReferences { get; init; } = new();
    }
}
