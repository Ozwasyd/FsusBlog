using System.Diagnostics;
using System.Reflection;
using System.Text.Json;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

internal static partial class XunitAdapterProgram
{
    private sealed record ResolvedReferenceContext(
        List<MetadataReference> References,
        string TargetFramework,
        string NetCoreReferencePack,
        string IntermediateOutputPath,
        CSharpParseOptions ParseOptions,
        bool AllowUnsafeBlocks);

    private static ResolvedReferenceContext BuildReferences(
        string projectDir,
        string projectPath,
        string configuration)
    {
        using JsonDocument evaluation = EvaluateCompileReferences(projectDir, projectPath, configuration);
        JsonElement root = evaluation.RootElement;
        JsonElement properties = root.GetProperty("Properties");
        string targetFramework = properties.GetProperty("TargetFramework").GetString()?.Trim() ?? "";
        string targetingPackRoot = properties.GetProperty("NetCoreTargetingPackRoot").GetString()?.Trim() ?? "";
        if (targetFramework.Length == 0 || targetingPackRoot.Length == 0)
        {
            throw new InvalidOperationException(
                "MSBuild ResolveReferences did not return TargetFramework and NetCoreTargetingPackRoot");
        }
        if (properties.GetProperty("Configuration").GetString() != configuration)
        {
            throw new InvalidOperationException("MSBuild compile configuration differs from the requested configuration");
        }
        string targetPath = ResolveEvaluatedPath(properties, "TargetPath", projectDir);
        string intermediateOutputPath = ResolveEvaluatedPath(properties, "IntermediateOutputPath", projectDir);
        // ResolveReferences can recreate caches/global usings without compiling.
        // A recreated directory is not proof of a built configuration.
        string intermediateAssemblyPath = Path.Combine(intermediateOutputPath, Path.GetFileName(targetPath));
        if (!File.Exists(targetPath) || !File.Exists(intermediateAssemblyPath))
        {
            throw new InvalidOperationException(
                $"test project {configuration} build output or intermediate context is missing at {targetPath} / {intermediateOutputPath}; run dotnet build with the requested configuration first");
        }
        string languageVersion = properties.GetProperty("LangVersion").GetString() ?? "";
        if (languageVersion.Length == 0 || !LanguageVersionFacts.TryParse(languageVersion, out LanguageVersion parsedLanguageVersion))
        {
            throw new InvalidOperationException($"MSBuild returned an unsupported LangVersion: {languageVersion}");
        }
        string[] symbols = (properties.GetProperty("DefineConstants").GetString() ?? "")
            .Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(symbol => symbol, StringComparer.Ordinal)
            .ToArray();
        var parseOptions = new CSharpParseOptions(parsedLanguageVersion, preprocessorSymbols: symbols);
        if (!bool.TryParse(properties.GetProperty("AllowUnsafeBlocks").GetString(), out bool allowUnsafeBlocks))
        {
            throw new InvalidOperationException("MSBuild did not return a valid AllowUnsafeBlocks value");
        }

        JsonElement referenceItems = root.GetProperty("Items").GetProperty("ReferencePath");
        var references = new List<MetadataReference>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var frameworkNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? frameworkVersion = null;
        string? regularExpressionsPath = null;
        foreach (JsonElement item in referenceItems.EnumerateArray())
        {
            string referencePath = item.GetProperty("FullPath").GetString()?.Trim()
                ?? item.GetProperty("Identity").GetString()?.Trim()
                ?? "";
            if (referencePath.Length == 0 || !File.Exists(referencePath))
            {
                throw new InvalidOperationException(
                    $"MSBuild ResolveReferences returned a missing compile reference: {referencePath}");
            }
            string simpleName = ReadAssemblySimpleName(referencePath);
            if (!seenNames.Add(simpleName))
            {
                throw new InvalidOperationException(
                    $"MSBuild ResolveReferences returned duplicate assembly identity {simpleName}");
            }
            references.Add(MetadataReference.CreateFromFile(referencePath));

            string frameworkName = OptionalMetadata(item, "FrameworkReferenceName");
            if (frameworkName.Length > 0)
            {
                frameworkNames.Add(simpleName);
            }
            if (simpleName == "System.Text.RegularExpressions"
                && frameworkName == "Microsoft.NETCore.App"
                && OptionalMetadata(item, "NuGetPackageId") == "Microsoft.NETCore.App.Ref")
            {
                frameworkVersion = OptionalMetadata(item, "FrameworkReferenceVersion");
                regularExpressionsPath = Path.GetFullPath(referencePath);
            }
        }

        if (frameworkVersion is null || regularExpressionsPath is null)
        {
            throw new InvalidOperationException(
                "MSBuild ResolveReferences did not bind System.Text.RegularExpressions from Microsoft.NETCore.App.Ref");
        }
        string exactReferencePack = Path.GetFullPath(Path.Combine(
            targetingPackRoot,
            "Microsoft.NETCore.App.Ref",
            frameworkVersion,
            "ref",
            targetFramework));
        if (!Path.GetDirectoryName(regularExpressionsPath)!.Equals(exactReferencePack, StringComparison.Ordinal)
            || !Path.Combine(exactReferencePack, "System.Text.RegularExpressions.dll")
                .Equals(regularExpressionsPath, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"MSBuild System.Text.RegularExpressions reference is outside its exact targeting pack: {regularExpressionsPath}");
        }

        RejectOutputFrameworkShadows(Path.GetDirectoryName(targetPath)!, frameworkNames);
        return new ResolvedReferenceContext(
            references, targetFramework, exactReferencePack, intermediateOutputPath, parseOptions, allowUnsafeBlocks);
    }

    private static string ResolveEvaluatedPath(JsonElement properties, string name, string projectDir)
    {
        string value = properties.GetProperty(name).GetString()?.Trim() ?? "";
        if (value.Length == 0)
        {
            throw new InvalidOperationException($"MSBuild did not return {name}");
        }
        return Path.GetFullPath(value, projectDir);
    }

    private static JsonDocument EvaluateCompileReferences(string projectDir, string projectPath, string configuration)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = projectDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in new[]
        {
            "msbuild",
            projectPath,
            "-target:ResolveReferences",
            "-getProperty:TargetFramework",
            "-getProperty:NetCoreTargetingPackRoot",
            "-getProperty:Configuration,TargetPath,IntermediateOutputPath,DefineConstants,LangVersion,AllowUnsafeBlocks",
            "-getItem:ReferencePath",
            "-verbosity:quiet",
            $"/p:Configuration={configuration}",
            "/p:BuildProjectReferences=false"
        })
        {
            startInfo.ArgumentList.Add(argument);
        }
        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("failed to start dotnet msbuild ResolveReferences");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Task.WaitAll(stdout, stderr);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"dotnet msbuild ResolveReferences failed ({process.ExitCode}): {stderr.Result.Trim()}");
        }
        try
        {
            return JsonDocument.Parse(stdout.Result);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException(
                $"dotnet msbuild ResolveReferences returned invalid JSON: {stdout.Result.Trim()}",
                error);
        }
    }

    private static void RejectOutputFrameworkShadows(
        string output,
        HashSet<string> frameworkNames)
    {
        foreach (string dll in Directory.EnumerateFiles(output, "*.dll").OrderBy(file => file, StringComparer.Ordinal))
        {
            string simpleName = ReadAssemblySimpleName(dll);
            if (frameworkNames.Contains(simpleName))
            {
                throw new InvalidOperationException(
                    $"test output assembly shadows MSBuild target reference-pack identity {simpleName}: {dll}");
            }
        }
    }

    private static string OptionalMetadata(JsonElement item, string name)
    {
        return item.TryGetProperty(name, out JsonElement property)
            ? property.GetString()?.Trim() ?? ""
            : "";
    }

    private static string ReadAssemblySimpleName(string assemblyPath)
    {
        return AssemblyName.GetAssemblyName(assemblyPath).Name
            ?? throw new InvalidOperationException($"assembly identity has no name: {assemblyPath}");
    }
}
