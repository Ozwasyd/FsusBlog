internal static partial class XunitAdapterProgram
{
    public sealed class Result
    {
        public string Schema { get; init; } = ReportSchema;
        public string Adapter { get; init; } = AdapterId;
        public string AdapterVersion { get; init; } = XunitAdapterProgram.AdapterVersion;
        public List<TestCase> TestCases { get; init; } = new();
        public List<DiagnosticEntry> Diagnostics { get; init; } = new();
    }

    public sealed class Position
    {
        public int Line
        {
            get; init;
        }
        public int Column
        {
            get; init;
        }
    }

    public sealed class Span
    {
        public Position Start { get; init; } = new();
        public Position End { get; init; } = new();
    }

    public sealed class Trait
    {
        public string Name { get; init; } = "";
        public string Value { get; init; } = "";
    }
}
