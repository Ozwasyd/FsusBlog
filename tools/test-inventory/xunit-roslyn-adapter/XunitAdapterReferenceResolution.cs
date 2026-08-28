using System.Text.Json;

using Microsoft.CodeAnalysis;

internal static partial class XunitAdapterProgram
{
    private static List<MetadataReference> BuildReferences(
        string root,
        string projectDir,
        string projectPath,
        string targetFramework)
    {
        var references = new List<MetadataReference>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        string? output = FindOutputDirectory(projectDir, projectPath);
        if (output is null)
        {
            throw new InvalidOperationException(
                $"test project build output is missing under {ResolveProjectBuildDirectory(projectDir, projectPath, "bin")}; run dotnet build first");
        }
        foreach (string dll in Directory.EnumerateFiles(output, "*.dll").OrderBy(file => file, StringComparer.Ordinal))
        {
            string simpleName = Path.GetFileNameWithoutExtension(dll);
            if (simpleName == Path.GetFileNameWithoutExtension(projectDir)
                || simpleName is "Microsoft.CodeAnalysis" or "Microsoft.CodeAnalysis.CSharp" or "Microsoft.CodeAnalysis.Analyzers" or "Microsoft.CodeAnalysis.Common")
            {
                continue;
            }
            if (seenNames.Add(simpleName))
            {
                references.Add(MetadataReference.CreateFromFile(dll));
            }
        }

        foreach (string dll in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll").OrderBy(file => file, StringComparer.Ordinal))
        {
            string simpleName = Path.GetFileNameWithoutExtension(dll);
            if (simpleName.StartsWith("FsusBlog.XunitRoslynAdapter", StringComparison.Ordinal))
                continue;
            if (seenNames.Add(simpleName))
            {
                references.Add(MetadataReference.CreateFromFile(dll));
            }
        }

        string refPack = ResolveReferencePack(targetFramework);
        if (refPack is not null)
        {
            foreach (string dll in Directory.EnumerateFiles(refPack, "*.dll").OrderBy(file => file, StringComparer.Ordinal))
            {
                string simpleName = Path.GetFileNameWithoutExtension(dll);
                if (seenNames.Add(simpleName))
                {
                    references.Add(MetadataReference.CreateFromFile(dll));
                }
            }
        }
        List<string> sharedFrameworks = ResolveSharedFrameworks(output);

        foreach (string sharedFramework in sharedFrameworks)
        {
            foreach (string dll in Directory.EnumerateFiles(sharedFramework, "*.dll").OrderBy(file => file, StringComparer.Ordinal))
            {
                string simpleName = Path.GetFileNameWithoutExtension(dll);
                if (seenNames.Add(simpleName))
                {
                    references.Add(MetadataReference.CreateFromFile(dll));
                }
            }
        }
        return references;
    }

    private static List<string> ResolveSharedFrameworks(string outputDirectory)
    {
        var frameworks = new List<string>();
        string? dotnetRoot = ResolveDotnetRoot();
        foreach (string file in Directory.EnumerateFiles(outputDirectory, "*.runtimeconfig.json"))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(file));
                JsonElement frameworksElement = document.RootElement.GetProperty("runtimeOptions").GetProperty("frameworks");
                foreach (JsonElement framework in frameworksElement.EnumerateArray())
                {
                    string name = framework.GetProperty("name").GetString() ?? "";
                    string version = framework.GetProperty("version").GetString() ?? "";
                    string? shared = ResolveSharedFramework(dotnetRoot, name, version);
                    if (shared is not null)
                    {
                        frameworks.Add(shared);
                    }
                }
            }
            catch
            {
                // Ignore unreadable runtime configs; NETCore.App ref pack still covers the BCL.
            }
        }
        if (frameworks.Count == 0 && dotnetRoot is not null)
        {
            string fallback = Path.Combine(dotnetRoot, "shared", "Microsoft.AspNetCore.App");
            if (Directory.Exists(fallback))
            {
                string? best = Directory.EnumerateDirectories(fallback).OrderBy(item => item, StringComparer.Ordinal).LastOrDefault();
                if (best is not null)
                    frameworks.Add(best);
            }
        }
        return frameworks;
    }

    private static string? ResolveSharedFramework(string? dotnetRoot, string name, string version)
    {
        if (dotnetRoot is null || name != "Microsoft.AspNetCore.App")
            return null;
        string shared = Path.Combine(dotnetRoot, "shared", name, version);
        if (Directory.Exists(shared))
            return shared;
        string packRoot = Path.Combine(dotnetRoot, "shared", name);
        return Directory.Exists(packRoot)
            ? Directory.EnumerateDirectories(packRoot).OrderBy(item => item, StringComparer.Ordinal).LastOrDefault()
            : null;
    }

}
