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

    private static string[] CollectSourceFiles(string projectDir, string intermediateOutputPath)
    {
        var files = new List<string>();
        CollectCsFiles(projectDir, files);
        foreach (string generated in Directory.EnumerateFiles(intermediateOutputPath, "*.g.cs", SearchOption.AllDirectories))
        {
            files.Add(generated);
        }
        return files
            .Where(file =>
            {
                string relative = Path.GetRelativePath(projectDir, file).Replace(Path.DirectorySeparatorChar, '/');
                if (relative.StartsWith("Fixtures/security-source-analysis/", StringComparison.Ordinal))
                    return false;
                if (relative.StartsWith("Fixtures/", StringComparison.Ordinal) && file.Contains("/Fixtures/", StringComparison.Ordinal))
                {
                    return !relative.Contains("security-source-analysis", StringComparison.Ordinal);
                }
                return true;
            })
            .Distinct(StringComparer.Ordinal)
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToArray();
    }

    private static void CollectCsFiles(string directory, List<string> files)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            string name = Path.GetFileName(entry);
            if (name is "bin" or "obj" or "node_modules")
                continue;
            if (Directory.Exists(entry))
                CollectCsFiles(entry, files);
            else if (entry.EndsWith(".cs", StringComparison.Ordinal))
                files.Add(entry);
        }
    }

}
