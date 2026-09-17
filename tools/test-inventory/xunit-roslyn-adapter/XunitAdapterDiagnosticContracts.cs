internal static partial class XunitAdapterProgram
{
    public sealed class DynamicCaseInfo
    {
        public string GenerationLocation { get; init; } = "";
        public string InventoryObligation { get; init; } = "";
    }

    public sealed class DiagnosticEntry
    {
        public string Severity { get; init; } = "warning";
        public string Code { get; init; } = "";
        public string File { get; init; } = "";
        public string Message { get; init; } = "";
    }
}
