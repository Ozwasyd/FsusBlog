using Microsoft.CodeAnalysis;

internal static partial class XunitAdapterProgram
{
    private static bool TryGetUnresolved(ISymbol symbol, string file, List<string> unresolved)
    {
        return symbol is null;
    }

    private static bool IsAttributeType(AttributeData attribute, string simpleName)
    {
        return attribute?.AttributeClass?.Name == simpleName
            || attribute?.AttributeClass?.ToDisplayString().EndsWith("." + simpleName, StringComparison.Ordinal) == true;
    }

    private static bool TryGetTestAttribute(IMethodSymbol method, out AttributeData? testAttribute)
    {
        testAttribute = method.GetAttributes().FirstOrDefault(attribute =>
        {
            string name = attribute.AttributeClass?.Name ?? "";
            string full = attribute.AttributeClass?.ToDisplayString() ?? "";
            return name is "FactAttribute" or "TheoryAttribute"
                || full is "Xunit.FactAttribute" or "Xunit.TheoryAttribute"
                || full.EndsWith(".FactAttribute", StringComparison.Ordinal)
                || full.EndsWith(".TheoryAttribute", StringComparison.Ordinal);
        });
        return testAttribute is not null;
    }

    private static string[] CollectSourceFiles(string projectDir, System.Text.Json.JsonElement compileItems)
    {
        if (compileItems.ValueKind != System.Text.Json.JsonValueKind.Array)
        {
            throw new InvalidOperationException("MSBuild Compile did not return a source item array");
        }
        var files = new HashSet<string>(StringComparer.Ordinal);
        foreach (System.Text.Json.JsonElement item in compileItems.EnumerateArray())
        {
            string value = item.GetProperty("FullPath").GetString() ?? "";
            if (value.Length == 0 || !Path.IsPathFullyQualified(value))
            {
                throw new InvalidOperationException("MSBuild Compile returned a source without an absolute FullPath");
            }
            string file = Path.GetFullPath(value, projectDir);
            if (!File.Exists(file) || !file.EndsWith(".cs", StringComparison.Ordinal)
                || !files.Add(file))
            {
                throw new InvalidOperationException($"MSBuild Compile returned a missing, unsupported or duplicate source: {file}");
            }
        }
        if (files.Count == 0)
        {
            throw new InvalidOperationException("MSBuild Compile returned no source items");
        }
        return files.OrderBy(file => file, StringComparer.Ordinal).ToArray();
    }

}
