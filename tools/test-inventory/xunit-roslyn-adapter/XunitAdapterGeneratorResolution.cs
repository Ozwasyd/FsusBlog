using System.Collections.Immutable;
using System.Reflection;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

internal static partial class XunitAdapterProgram
{
    private static (CSharpCompilation Compilation, ImmutableArray<Diagnostic> Diagnostics) RunRegexSourceGenerator(
        CSharpCompilation compilation,
        CSharpParseOptions parseOptions,
        string targetFramework)
    {
        string refPack = ResolveReferencePack(targetFramework)
            ?? throw new InvalidOperationException($"target reference pack is unavailable for {targetFramework}");
        string generatorPath = Path.GetFullPath(Path.Combine(
            refPack,
            "..",
            "..",
            "analyzers",
            "dotnet",
            "cs",
            "System.Text.RegularExpressions.Generator.dll"));
        if (!File.Exists(generatorPath))
        {
            throw new InvalidOperationException(
                $"target framework regex source generator is unavailable at {generatorPath}");
        }

        string regularExpressionsPath = Path.Combine(refPack, "System.Text.RegularExpressions.dll");
        PortableExecutableReference? regularExpressionsReference = compilation.References
            .OfType<PortableExecutableReference>()
            .SingleOrDefault(reference => reference.FilePath is not null
                && Path.GetFullPath(reference.FilePath).Equals(regularExpressionsPath, StringComparison.Ordinal));
        if (regularExpressionsReference is null
            || compilation.GetAssemblyOrModuleSymbol(regularExpressionsReference) is not IAssemblySymbol trustedAssembly
            || trustedAssembly.Identity.PublicKeyToken.IsDefaultOrEmpty)
        {
            throw new InvalidOperationException(
                "trusted System.Text.RegularExpressions target reference-pack identity is unavailable");
        }
        INamedTypeSymbol? generatedRegexAttribute = compilation.GetTypeByMetadataName(
            "System.Text.RegularExpressions.GeneratedRegexAttribute");
        INamedTypeSymbol? regexType = compilation.GetTypeByMetadataName(
            "System.Text.RegularExpressions.Regex");
        if (generatedRegexAttribute is null
            || regexType is null
            || !generatedRegexAttribute.ContainingAssembly.Identity.Equals(trustedAssembly.Identity)
            || !regexType.ContainingAssembly.Identity.Equals(trustedAssembly.Identity))
        {
            throw new InvalidOperationException(
                $"GeneratedRegex semantic types do not bind the trusted target reference-pack identity {trustedAssembly.Identity}");
        }

        Assembly generatorAssembly = Assembly.LoadFrom(generatorPath);
        if (!Path.GetFullPath(generatorAssembly.Location).Equals(generatorPath, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"regex source generator resolved outside the target framework pack: {generatorAssembly.Location}");
        }
        Type generatorType = generatorAssembly.GetType(
            "System.Text.RegularExpressions.Generator.RegexGenerator",
            throwOnError: true,
            ignoreCase: false)!;
        if (Activator.CreateInstance(generatorType) is not IIncrementalGenerator incrementalGenerator)
        {
            throw new InvalidOperationException(
                $"target framework regex generator type is invalid in {generatorPath}");
        }

        GeneratorDriver driver = CSharpGeneratorDriver.Create(
            generators: [incrementalGenerator.AsSourceGenerator()],
            parseOptions: parseOptions);
        driver.RunGeneratorsAndUpdateCompilation(
            compilation,
            out Compilation generatedCompilation,
            out ImmutableArray<Diagnostic> generatorDiagnostics);
        if (generatedCompilation is not CSharpCompilation csharpCompilation)
        {
            throw new InvalidOperationException("regex generator returned a non-C# compilation");
        }
        return (csharpCompilation, generatorDiagnostics);
    }
}
