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

    private static bool ReadAllowUnsafeBlocks(string projectPath)
    {
        string projectText = File.ReadAllText(projectPath);
        int index = projectText.IndexOf("<AllowUnsafeBlocks>", StringComparison.Ordinal);
        if (index < 0)
            return false;
        int start = index + "<AllowUnsafeBlocks>".Length;
        int end = projectText.IndexOf("</AllowUnsafeBlocks>", start, StringComparison.Ordinal);
        return end > start && bool.TryParse(projectText[start..end].Trim(), out bool value) && value;
    }

    private static string[] CollectSourceFiles(string projectDir, string projectPath)
    {
        var files = new List<string>();
        CollectCsFiles(projectDir, files);
        string objDir = ResolveProjectBuildDirectory(projectDir, projectPath, "obj");
        if (Directory.Exists(objDir))
        {
            foreach (string generated in Directory.EnumerateFiles(objDir, "*.g.cs", SearchOption.AllDirectories))
            {
                files.Add(generated);
            }
        }
        string? expectedOutput = FindOutputDirectory(projectDir, projectPath);
        if (expectedOutput is not null && !Directory.Exists(expectedOutput))
        {
            throw new InvalidOperationException($"test project build output is missing at {expectedOutput}; run dotnet build on {Path.GetFileName(projectPath)} before invoking the adapter");
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

    private static string ResolveProjectBuildDirectory(string projectDir, string projectPath, string leaf)
    {
        string configuredRoot = Environment.GetEnvironmentVariable("FSUSBLOG_PRODUCTION_BUILD_ROOT")?.Trim() ?? "";
        return configuredRoot.Length == 0
            ? Path.Combine(projectDir, leaf)
            : Path.Combine(
                Path.GetFullPath(configuredRoot),
                "dotnet",
                Path.GetFileNameWithoutExtension(projectPath),
                leaf);
    }

    private static string? FindOutputDirectory(string projectDir, string projectPath)
    {
        string binDir = ResolveProjectBuildDirectory(projectDir, projectPath, "bin");
        if (!Directory.Exists(binDir))
            return null;
        foreach (string config in new[] { "Debug", "Release" })
        {
            string candidate = Path.Combine(binDir, config, "net10.0");
            if (Directory.Exists(candidate))
                return candidate;
        }
        foreach (string framework in Directory.EnumerateDirectories(binDir, "*", SearchOption.AllDirectories))
        {
            if (Directory.EnumerateFiles(framework, "*.dll").Any())
                return framework;
        }
        return null;
    }

}
