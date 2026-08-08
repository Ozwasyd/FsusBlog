using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: FsusBlog.XunitRoslynAdapter <repository-root> <test-project-path>");
    return 2;
}

string root = Path.GetFullPath(args[0]);
string projectArg = Path.GetFullPath(args[1]);

if (!File.Exists(projectArg))
{
    Console.Error.WriteLine($"xunit-roslyn-adapter fail closed: test project not found at {projectArg}");
    return 1;
}

XunitAdapterProgram.Result result = XunitAdapterProgram.Run(root, projectArg);
XunitAdapterProgram.WriteReport(result);
return result.Diagnostics.Any(item => item.Severity == "error") ? 1 : 0;

internal static class XunitAdapterProgram
{
    public const string AdapterId = "xunit";
    public const string AdapterVersion = "xunit.v2";
    public const string ReportSchema = "fsusblog.test-inventory.xunit-roslyn.v1";

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
        public int Line { get; init; }
        public int Column { get; init; }
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

    public sealed class MethodFact
    {
        public string MethodName { get; init; } = "";
        public string ContainingType { get; init; } = "";
        public string Assembly { get; init; } = "";
        public string AssemblyKind { get; init; } = "";
        public bool CallsTestMethod { get; init; }
        public string? CalledTestMethodId { get; set; }
        public Span? Location { get; init; }
    }

    public sealed class MethodFacts
    {
        public List<MethodFact> Invocations { get; init; } = new();
        public List<MethodFact> AssertionCandidates { get; init; } = new();
        public List<string> ReturnStatements { get; init; } = new();
        public List<MethodFact> ProductionSymbolReferences { get; init; } = new();
        public List<MethodFact> TestAttributeReferences { get; init; } = new();
    }

    public sealed class DynamicCaseInfo
    {
        public string GenerationLocation { get; init; } = "";
        public string InventoryObligation { get; init; } = "";
    }

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
        public Span? BodySpan { get; init; }
        public string? BodySource { get; init; }
        public List<Trait> Traits { get; init; } = new();
        public string? Category { get; init; }
        public string? Platform { get; init; }
        public string? Fixture { get; init; }
        public string? SkipReason { get; init; }
        public bool Explicit { get; init; }
        public int? TimeoutMs { get; init; }
        public DynamicCaseInfo? DynamicCaseInfo { get; init; }
        public MethodFacts MethodFacts { get; init; } = new();
    }

    public sealed class DiagnosticEntry
    {
        public string Severity { get; init; } = "warning";
        public string Code { get; init; } = "";
        public string File { get; init; } = "";
        public string Message { get; init; } = "";
    }

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static Result Run(string root, string projectPath)
    {
        var result = new Result();
        string projectDir = Path.GetDirectoryName(projectPath) ?? root;
        string relativeProject = Path.GetRelativePath(root, projectPath).Replace(Path.DirectorySeparatorChar, '/');
        string targetFramework = ReadTargetFramework(projectPath) ?? "net10.0";

        string[] sources;
        try
        {
            sources = CollectSourceFiles(projectDir, projectPath);
        }
        catch (Exception error)
        {
            result.Diagnostics.Add(new DiagnosticEntry
            {
                Severity = "error",
                Code = "xunit-compile-context-unavailable",
                File = relativeProject,
                Message = error.Message
            });
            return result;
        }

        List<MetadataReference> references;
        try
        {
            references = BuildReferences(root, projectDir, targetFramework);
        }
        catch (Exception error)
        {
            result.Diagnostics.Add(new DiagnosticEntry
            {
                Severity = "error",
                Code = "xunit-compile-context-unavailable",
                File = relativeProject,
                Message = error.Message
            });
            return result;
        }

        var syntaxTrees = new List<SyntaxTree>();
        var sourceByTree = new Dictionary<string, string>();
        foreach (string sourcePath in sources)
        {
            string relative = Path.GetRelativePath(root, sourcePath).Replace(Path.DirectorySeparatorChar, '/');
            string sourceText = File.ReadAllText(sourcePath);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(sourceText, new CSharpParseOptions(LanguageVersion.Latest), path: sourcePath);
            syntaxTrees.Add(tree);
            sourceByTree[tree.FilePath] = relative;
        }

        string assemblyName = Path.GetFileNameWithoutExtension(projectPath);
        var compilation = CSharpCompilation.Create(
            assemblyName,
            syntaxTrees,
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var missingReferenceDiagnostics = compilation.GetDiagnostics()
            .Where(item => item.Severity == DiagnosticSeverity.Error
                && item.Id is "CS0006" or "CS0009" or "CS0012" or "CS0234" or "CS0246" or "CS0103" or "CS0400")
            .Take(40)
            .Select(item => item.ToString())
            .ToArray();
        if (missingReferenceDiagnostics.Length > 0)
        {
            result.Diagnostics.Add(new DiagnosticEntry
            {
                Severity = "error",
                Code = "xunit-semantic-model-incomplete",
                File = relativeProject,
                Message = "semantic model is incomplete; unresolved symbols: " + string.Join(" | ", missingReferenceDiagnostics)
            });
            return result;
        }

        var unresolvedSymbols = new List<string>();
        var seenTestMethods = new Dictionary<IMethodSymbol, MethodDeclarationSyntax>();

        foreach (SyntaxTree tree in syntaxTrees)
        {
            string relativeFile = sourceByTree[tree.FilePath];
            var semanticModel = compilation.GetSemanticModel(tree);
            var rootNode = tree.GetRoot();
            foreach (ClassDeclarationSyntax classDeclaration in rootNode.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var classSymbol = semanticModel.GetDeclaredSymbol(classDeclaration) as INamedTypeSymbol;
                if (classSymbol is null)
                {
                    unresolvedSymbols.Add($"{relativeFile}:{classDeclaration.Identifier.ValueText}");
                    continue;
                }
                foreach (MethodDeclarationSyntax methodDeclaration in classDeclaration.Members.OfType<MethodDeclarationSyntax>())
                {
                    var methodSymbol = semanticModel.GetDeclaredSymbol(methodDeclaration);
                    if (methodSymbol is null)
                    {
                        unresolvedSymbols.Add($"{relativeFile}:{methodDeclaration.Identifier.ValueText}");
                        continue;
                    }
                    seenTestMethods[methodSymbol] = methodDeclaration;

                    if (!TryGetTestAttribute(methodSymbol, out AttributeData? testAttribute))
                    {
                        continue;
                    }
                    bool isTheory = IsAttributeType(testAttribute, "TheoryAttribute");

                    if (TryGetUnresolved(methodSymbol, relativeFile, unresolvedSymbols))
                    {
                        result.Diagnostics.Add(new DiagnosticEntry
                        {
                            Severity = "error",
                            Code = "xunit-semantic-model-incomplete",
                            File = relativeFile,
                            Message = $"cannot resolve test method symbol {methodSymbol.Name}"
                        });
                        continue;
                    }

                    string ownerSuite = classSymbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
                        .Replace("global::", "")
                        .Replace("<", "{").Replace(">", "}")
                        .Replace(",", ";")
                        .Replace(" ", "_");
                    string ownerClass = classSymbol.Name;
                    string methodName = methodSymbol.Name;
                    string pathStable = relativeFile.Replace("/", "_").Replace("#", "_").Replace("?", "_");

                    string? bodySource = null;
                    Span? bodySpan = null;
                    if (methodDeclaration.Body is not null)
                    {
                        bodySource = methodDeclaration.Body.ToString();
                        bodySpan = GetSpan(methodDeclaration.Body, tree);
                    }
                    else if (methodDeclaration.ExpressionBody is not null)
                    {
                        bodySource = methodDeclaration.ExpressionBody.ToString();
                        bodySpan = GetSpan(methodDeclaration.ExpressionBody, tree);
                    }

                    var (classTraits, fixture) = ClassMetadata(classSymbol, semanticModel, relativeFile, unresolvedSymbols);
                    var (methodTraits, skipReason, explicitFlag, timeoutMs, displayNameOverride) = MethodMetadata(
                        methodSymbol, testAttribute, semanticModel, relativeFile, unresolvedSymbols);
                    var traits = MergeTraits(classTraits, methodTraits);
                    string? category = TraitValue(traits, "Category");
                    string? platform = TraitValue(traits, "Platform");
                    string displayName = displayNameOverride
                        ?? (isTheory && methodDeclaration.ParameterList.Parameters.Count > 0
                            ? $"{ownerClass}.{methodName}"
                            : $"{ownerClass}.{methodName}");

                    var methodFacts = BuildMethodFacts(methodSymbol, methodDeclaration, semanticModel, relativeFile, seenTestMethods, unresolvedSymbols);

                    int caseNumber = 0;
                    bool hasStaticData = false;
                    bool hasDynamicData = false;

                    if (isTheory)
                    {
                        foreach (AttributeData attribute in methodSymbol.GetAttributes())
                        {
                            if (IsAttributeType(attribute, "InlineDataAttribute"))
                            {
                                hasStaticData = true;
                                string label = InlineDataLabel(attribute);
                                string caseId = StableCaseId(relativeFile, ownerSuite, methodName, $"case-{caseNumber:0000}");
                                string caseLabel = $"case {caseNumber}: {label}";
                                result.TestCases.Add(new TestCase
                                {
                                    Id = caseId,
                                    DisplayName = $"{displayName} [{caseLabel}]",
                                    Kind = "theory-inline",
                                    Identity = "static",
                                    OwnerFile = relativeFile,
                                    OwnerClass = ownerClass,
                                    OwnerSuite = ownerSuite,
                                    MethodName = methodName,
                                    SourceSpan = GetSpan(methodDeclaration, tree),
                                    BodySpan = bodySpan,
                                    BodySource = bodySource,
                                    Traits = traits,
                                    Category = category,
                                    Platform = platform,
                                    Fixture = fixture,
                                    SkipReason = skipReason,
                                    Explicit = explicitFlag,
                                    TimeoutMs = timeoutMs,
                                    MethodFacts = methodFacts
                                });
                                caseNumber += 1;
                            }
                            else if (IsAttributeType(attribute, "MemberDataAttribute"))
                            {
                                hasDynamicData = true;
                                string generation = MemberDataGenerationLocation(attribute) ?? "member-data";
                                string caseId = StableCaseId(relativeFile, ownerSuite, methodName, $"dynamic-{caseNumber:0000}");
                                result.TestCases.Add(new TestCase
                                {
                                    Id = caseId,
                                    DisplayName = $"{displayName} [dynamic member data {generation}]",
                                    Kind = "theory-member-data",
                                    Identity = "dynamic",
                                    OwnerFile = relativeFile,
                                    OwnerClass = ownerClass,
                                    OwnerSuite = ownerSuite,
                                    MethodName = methodName,
                                    SourceSpan = GetSpan(methodDeclaration, tree),
                                    BodySpan = bodySpan,
                                    BodySource = bodySource,
                                    Traits = traits,
                                    Category = category,
                                    Platform = platform,
                                    Fixture = fixture,
                                    SkipReason = skipReason,
                                    Explicit = explicitFlag,
                                    TimeoutMs = timeoutMs,
                                    DynamicCaseInfo = new DynamicCaseInfo
                                    {
                                        GenerationLocation = generation,
                                        InventoryObligation = $"runtime inventory must record every executed case id after {generation} execution for {ownerSuite}.{methodName}"
                                    },
                                    MethodFacts = methodFacts
                                });
                                caseNumber += 1;
                            }
                            else if (IsAttributeType(attribute, "ClassDataAttribute"))
                            {
                                hasDynamicData = true;
                                string generation = ClassDataGenerationLocation(attribute) ?? "class-data";
                                string caseId = StableCaseId(relativeFile, ownerSuite, methodName, $"dynamic-{caseNumber:0000}");
                                result.TestCases.Add(new TestCase
                                {
                                    Id = caseId,
                                    DisplayName = $"{displayName} [dynamic class data {generation}]",
                                    Kind = "theory-class-data",
                                    Identity = "dynamic",
                                    OwnerFile = relativeFile,
                                    OwnerClass = ownerClass,
                                    OwnerSuite = ownerSuite,
                                    MethodName = methodName,
                                    SourceSpan = GetSpan(methodDeclaration, tree),
                                    BodySpan = bodySpan,
                                    BodySource = bodySource,
                                    Traits = traits,
                                    Category = category,
                                    Platform = platform,
                                    Fixture = fixture,
                                    SkipReason = skipReason,
                                    Explicit = explicitFlag,
                                    TimeoutMs = timeoutMs,
                                    DynamicCaseInfo = new DynamicCaseInfo
                                    {
                                        GenerationLocation = generation,
                                        InventoryObligation = $"runtime inventory must record every executed case id after {generation} execution for {ownerSuite}.{methodName}"
                                    },
                                    MethodFacts = methodFacts
                                });
                                caseNumber += 1;
                            }
                        }
                        if (!hasStaticData && !hasDynamicData)
                        {
                            string caseId = StableCaseId(relativeFile, ownerSuite, methodName, "case-0000");
                            result.TestCases.Add(new TestCase
                            {
                                Id = caseId,
                                DisplayName = displayName,
                                Kind = "theory",
                                Identity = "dynamic",
                                OwnerFile = relativeFile,
                                OwnerClass = ownerClass,
                                OwnerSuite = ownerSuite,
                                MethodName = methodName,
                                SourceSpan = GetSpan(methodDeclaration, tree),
                                BodySpan = bodySpan,
                                BodySource = bodySource,
                                Traits = traits,
                                Category = category,
                                Platform = platform,
                                Fixture = fixture,
                                SkipReason = skipReason,
                                Explicit = explicitFlag,
                                TimeoutMs = timeoutMs,
                                DynamicCaseInfo = new DynamicCaseInfo
                                {
                                    GenerationLocation = $"{relativeFile}:{ownerSuite}.{methodName}",
                                    InventoryObligation = $"runtime inventory must record every executed case id after {ownerSuite}.{methodName} execution; no statically expandable data rows were found"
                                },
                                MethodFacts = methodFacts
                            });
                        }
                    }
                    else
                    {
                        string caseId = StableCaseId(relativeFile, ownerSuite, methodName, "case-0000");
                        result.TestCases.Add(new TestCase
                        {
                            Id = caseId,
                            DisplayName = displayName,
                            Kind = "fact",
                            Identity = "static",
                            OwnerFile = relativeFile,
                            OwnerClass = ownerClass,
                            OwnerSuite = ownerSuite,
                            MethodName = methodName,
                            SourceSpan = GetSpan(methodDeclaration, tree),
                            BodySpan = bodySpan,
                            BodySource = bodySource,
                            Traits = traits,
                            Category = category,
                            Platform = platform,
                            Fixture = fixture,
                            SkipReason = skipReason,
                            Explicit = explicitFlag,
                            TimeoutMs = timeoutMs,
                            MethodFacts = methodFacts
                        });
                    }
                }
            }
        }

        foreach (string unresolved in unresolvedSymbols.Distinct(StringComparer.Ordinal).OrderBy(item => item, StringComparer.Ordinal))
        {
            result.Diagnostics.Add(new DiagnosticEntry
            {
                Severity = "error",
                Code = "xunit-unresolved-symbol",
                Message = unresolved
            });
        }

        result.TestCases.Sort((left, right) => string.CompareOrdinal(left.Id, right.Id));
        result.Diagnostics.Sort((left, right) =>
            string.CompareOrdinal(left.Severity, right.Severity) == 0
                ? string.CompareOrdinal(left.Code, right.Code)
                : string.CompareOrdinal(left.Severity, right.Severity));
        return result;
    }

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

    private static string ReadTargetFramework(string projectPath)
    {
        string projectText = File.ReadAllText(projectPath);
        int index = projectText.IndexOf("<TargetFramework>", StringComparison.Ordinal);
        if (index < 0) return "net10.0";
        int start = index + "<TargetFramework>".Length;
        int end = projectText.IndexOf("</TargetFramework>", start, StringComparison.Ordinal);
        return end > start ? projectText[start..end].Trim() : "net10.0";
    }

    private static string[] CollectSourceFiles(string projectDir, string projectPath)
    {
        var files = new List<string>();
        CollectCsFiles(projectDir, files);
        string objDir = Path.Combine(projectDir, "obj");
        if (Directory.Exists(objDir))
        {
            foreach (string generated in Directory.EnumerateFiles(objDir, "*.g.cs", SearchOption.AllDirectories))
            {
                files.Add(generated);
            }
        }
        string expectedOutput = FindOutputDirectory(projectDir);
        if (expectedOutput is not null && !Directory.Exists(expectedOutput))
        {
            throw new InvalidOperationException($"test project build output is missing at {expectedOutput}; run dotnet build on {Path.GetFileName(projectPath)} before invoking the adapter");
        }
        return files
            .Where(file =>
            {
                string relative = Path.GetRelativePath(projectDir, file).Replace(Path.DirectorySeparatorChar, '/');
                if (relative.StartsWith("Fixtures/security-source-analysis/", StringComparison.Ordinal)) return false;
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
            if (name is "bin" or "obj" or "node_modules") continue;
            if (Directory.Exists(entry)) CollectCsFiles(entry, files);
            else if (entry.EndsWith(".cs", StringComparison.Ordinal)) files.Add(entry);
        }
    }

    private static string? FindOutputDirectory(string projectDir)
    {
        string binDir = Path.Combine(projectDir, "bin");
        if (!Directory.Exists(binDir)) return null;
        foreach (string config in new[] { "Debug", "Release" })
        {
            string candidate = Path.Combine(binDir, config, "net10.0");
            if (Directory.Exists(candidate)) return candidate;
        }
        foreach (string framework in Directory.EnumerateDirectories(binDir, "*", SearchOption.AllDirectories))
        {
            if (Directory.EnumerateFiles(framework, "*.dll").Any()) return framework;
        }
        return null;
    }

    private static List<MetadataReference> BuildReferences(string root, string projectDir, string targetFramework)
    {
        var references = new List<MetadataReference>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        string? output = FindOutputDirectory(projectDir);
        if (output is null)
        {
            throw new InvalidOperationException($"test project build output is missing under {Path.Combine(projectDir, "bin")}; run dotnet build first");
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
            if (simpleName.StartsWith("FsusBlog.XunitRoslynAdapter", StringComparison.Ordinal)) continue;
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
        string runtimeConfig = Path.Combine(outputDirectory, "*.runtimeconfig.json");
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
                    if (name == "Microsoft.AspNetCore.App")
                    {
                        string shared = Path.Combine(dotnetRoot, "shared", name, version);
                        if (Directory.Exists(shared))
                        {
                            frameworks.Add(shared);
                        }
                        else
                        {
                            string packRoot = Path.Combine(dotnetRoot, "shared", name);
                            if (Directory.Exists(packRoot))
                            {
                                string? best = Directory.EnumerateDirectories(packRoot).OrderBy(item => item, StringComparer.Ordinal).LastOrDefault();
                                if (best is not null) frameworks.Add(best);
                            }
                        }
                    }
                }
            }
            catch
            {
                // Ignore unreadable runtime configs; NETCore.App ref pack still covers the BCL.
            }
        }
        if (frameworks.Count == 0)
        {
            string fallback = Path.Combine(dotnetRoot, "shared", "Microsoft.AspNetCore.App");
            if (Directory.Exists(fallback))
            {
                string? best = Directory.EnumerateDirectories(fallback).OrderBy(item => item, StringComparer.Ordinal).LastOrDefault();
                if (best is not null) frameworks.Add(best);
            }
        }
        return frameworks;
    }

    private static string? ResolveReferencePack(string targetFramework)
    {
        List<string> candidates = new();
        string? dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrWhiteSpace(dotnetRoot)) candidates.Add(dotnetRoot);
        string? dotnet = FindOnPath("dotnet");
        if (dotnet is not null)
        {
            candidates.Add(Path.GetDirectoryName(Path.GetDirectoryName(dotnet)) ?? "");
        }
        candidates.Add("/usr/share/dotnet");
        candidates.Add("/usr/lib/dotnet");
        foreach (string candidate in candidates.Where(item => !string.IsNullOrWhiteSpace(item)))
        {
            string packRoot = Path.Combine(candidate, "packs", "Microsoft.NETCore.App.Ref");
            if (!Directory.Exists(packRoot)) continue;
            string? best = null;
            foreach (string version in Directory.EnumerateDirectories(packRoot).OrderBy(item => item, StringComparer.Ordinal).Reverse())
            {
                string refDir = Path.Combine(version, "ref", targetFramework);
                if (Directory.Exists(refDir))
                {
                    best = refDir;
                    break;
                }
            }
            if (best is not null) return best;
        }
        return null;
    }

    private static string? ResolveDotnetRoot()
    {
        string? dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrWhiteSpace(dotnetRoot) && Directory.Exists(dotnetRoot)) return dotnetRoot;
        string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        if (!string.IsNullOrWhiteSpace(runtimeDir))
        {
            string candidate = Path.GetFullPath(Path.Combine(runtimeDir, "..", "..", "..", ".."));
            if (Directory.Exists(Path.Combine(candidate, "shared"))) return candidate;
        }
        foreach (string candidate in new[] { "/usr/share/dotnet", "/usr/lib/dotnet" })
        {
            if (Directory.Exists(Path.Combine(candidate, "shared"))) return candidate;
        }
        string? dotnet = FindOnPath("dotnet");
        if (dotnet is not null)
        {
            FileInfo info = new(dotnet);
            if (info.LinkTarget is not null)
            {
                string resolved = Path.GetFullPath(Path.Combine(info.DirectoryName ?? "", info.LinkTarget));
                string root = Path.GetDirectoryName(Path.GetDirectoryName(resolved)) ?? "";
                if (Directory.Exists(Path.Combine(root, "shared"))) return root;
            }
            string fromPath = Path.GetDirectoryName(Path.GetDirectoryName(dotnet)) ?? "";
            if (Directory.Exists(Path.Combine(fromPath, "shared"))) return fromPath;
        }
        return null;
    }

    private static string? FindOnPath(string executable)
    {
        string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in pathValue.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            string candidate = Path.Combine(directory.Trim(), executable);
            if (File.Exists(candidate)) return candidate;
            if (OperatingSystem.IsWindows() && File.Exists(candidate + ".exe")) return candidate + ".exe";
        }
        return null;
    }

    private static (List<Trait> Traits, string? Fixture) ClassMetadata(
        INamedTypeSymbol classSymbol,
        SemanticModel semanticModel,
        string file,
        List<string> unresolved)
    {
        var traits = new List<Trait>();
        string? fixture = null;
        foreach (AttributeData attribute in classSymbol.GetAttributes())
        {
            if (IsAttributeType(attribute, "TraitAttribute"))
            {
                Trait? trait = ReadTrait(attribute, semanticModel, file, unresolved);
                if (trait is not null) traits.Add(trait);
            }
        }
        for (INamedTypeSymbol? current = classSymbol; current is not null; current = current.BaseType)
        {
            foreach (INamedTypeSymbol iface in current.Interfaces)
            {
                string name = iface.ToDisplayString();
                if (name.StartsWith("Xunit.IClassFixture<", StringComparison.Ordinal)
                    || name.StartsWith("Xunit.ICollectionFixture<", StringComparison.Ordinal))
                {
                    string inner = name["Xunit.IClassFixture<".Length..];
                    if (inner.EndsWith(">", StringComparison.Ordinal)) inner = inner[..^1];
                    fixture = inner;
                }
            }
        }
        return (traits, fixture);
    }

    private static Trait? ReadTrait(AttributeData attribute, SemanticModel semanticModel, string file, List<string> unresolved)
    {
        var args = attribute.ConstructorArguments;
        if (args.Length < 2 || args[0].Value is null || args[1].Value is null)
        {
            return null;
        }
        return new Trait
        {
            Name = args[0].Value?.ToString() ?? "",
            Value = args[1].Value?.ToString() ?? ""
        };
    }

    private static (List<Trait> Traits, string? SkipReason, bool Explicit, int? TimeoutMs, string? DisplayName) MethodMetadata(
        IMethodSymbol method,
        AttributeData testAttribute,
        SemanticModel semanticModel,
        string file,
        List<string> unresolved)
    {
        var traits = new List<Trait>();
        string? skipReason = null;
        bool explicitFlag = false;
        int? timeoutMs = null;
        string? displayName = null;
        foreach (AttributeData attribute in method.GetAttributes())
        {
            if (IsAttributeType(attribute, "TraitAttribute"))
            {
                Trait? trait = ReadTrait(attribute, semanticModel, file, unresolved);
                if (trait is not null) traits.Add(trait);
            }
            else if (IsAttributeType(attribute, "FactAttribute") || IsAttributeType(attribute, "TheoryAttribute"))
            {
                foreach (KeyValuePair<string, TypedConstant> named in attribute.NamedArguments)
                {
                    switch (named.Key)
                    {
                        case "Skip":
                            skipReason = named.Value.Value?.ToString();
                            break;
                        case "Explicit":
                            explicitFlag = named.Value.Value is true;
                            break;
                        case "Timeout":
                            if (named.Value.Value is int timeout) timeoutMs = timeout;
                            break;
                        case "DisplayName":
                            displayName = named.Value.Value?.ToString();
                            break;
                    }
                }
            }
        }
        return (traits, skipReason, explicitFlag, timeoutMs, displayName);
    }

    private static List<Trait> MergeTraits(List<Trait> classTraits, List<Trait> methodTraits)
    {
        var merged = new List<Trait>();
        var methodNames = new HashSet<string>(methodTraits.Select(item => item.Name), StringComparer.Ordinal);
        merged.AddRange(classTraits.Where(item => !methodNames.Contains(item.Name)));
        merged.AddRange(methodTraits);
        return merged
            .GroupBy(item => item.Name, StringComparer.Ordinal)
            .Select(group => group.Last())
            .OrderBy(item => item.Name, StringComparer.Ordinal)
            .ThenBy(item => item.Value, StringComparer.Ordinal)
            .ToList();
    }

    private static string? TraitValue(List<Trait> traits, string name)
    {
        return traits.LastOrDefault(item => item.Name == name)?.Value;
    }

    private static string InlineDataLabel(AttributeData attribute)
    {
        var labels = new List<string>();
        foreach (TypedConstant argument in attribute.ConstructorArguments)
        {
            labels.Add(ConstantLabel(argument));
        }
        return labels.Count == 0 ? "no-arguments" : string.Join(", ", labels);
    }

    private static string ConstantLabel(TypedConstant constant)
    {
        if (constant.Kind == TypedConstantKind.Array)
        {
            if (constant.Values.IsDefault) return "[]";
            return "[" + string.Join(", ", constant.Values.Select(ConstantLabel)) + "]";
        }
        if (constant.Kind == TypedConstantKind.Primitive || constant.Kind == TypedConstantKind.Enum)
        {
            if (constant.Value is null) return "null";
            if (constant.Value is string value) return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            if (constant.Value is bool boolean) return boolean ? "true" : "false";
            if (constant.Value is char character) return "'" + character + "'";
            return Convert.ToString(constant.Value, System.Globalization.CultureInfo.InvariantCulture) ?? "null";
        }
        if (constant.Kind == TypedConstantKind.Type)
        {
            return constant.Value?.ToString() ?? "typeof(?)";
        }
        return constant.Value?.ToString() ?? "null";
    }

    private static string? MemberDataGenerationLocation(AttributeData attribute)
    {
        if (attribute.ConstructorArguments.Length == 0) return null;
        TypedConstant first = attribute.ConstructorArguments[0];
        if (first.Value is string memberName) return $"member-data:{memberName}";
        if (first.Value is INamedTypeSymbol type) return $"member-data:{type.Name}";
        return "member-data";
    }

    private static string? ClassDataGenerationLocation(AttributeData attribute)
    {
        if (attribute.ConstructorArguments.Length == 0) return null;
        TypedConstant first = attribute.ConstructorArguments[0];
        if (first.Value is INamedTypeSymbol type) return $"class-data:{type.ToDisplayString()}";
        return "class-data";
    }

    private static string StableCaseId(string file, string ownerSuite, string methodName, string discriminator)
    {
        string stableOwner = ownerSuite.Replace("+", ".");
        return $"xunit:{file}#{stableOwner}.{methodName}#{discriminator}";
    }

    private static Span GetSpan(SyntaxNode node, SyntaxTree tree)
    {
        FileLinePositionSpan lineSpan = tree.GetLineSpan(node.Span);
        return new Span
        {
            Start = new Position { Line = lineSpan.StartLinePosition.Line, Column = lineSpan.StartLinePosition.Character },
            End = new Position { Line = lineSpan.EndLinePosition.Line, Column = lineSpan.EndLinePosition.Character }
        };
    }

    private static string AssemblyKind(ISymbol symbol)
    {
        string assemblyName = symbol.ContainingAssembly?.Name ?? "";
        if (assemblyName.StartsWith("FsusBlog.", StringComparison.Ordinal)
            && assemblyName != "FsusBlog.Server.Tests"
            && assemblyName != "FsusBlog.XunitRoslynAdapter")
        {
            return "production";
        }
        if (assemblyName is "FsusBlog.Server.Tests" or "AdapterFixtureTests" or "FsusBlog.AdapterFixture") return "test";
        if (assemblyName.EndsWith("Tests", StringComparison.Ordinal) || assemblyName.EndsWith("Test", StringComparison.Ordinal)) return "test";
        if (assemblyName.StartsWith("xunit", StringComparison.OrdinalIgnoreCase)) return "test-framework";
        if (assemblyName.StartsWith("System", StringComparison.Ordinal)
            || assemblyName.StartsWith("Microsoft", StringComparison.Ordinal)
            || assemblyName.StartsWith("netstandard", StringComparison.Ordinal)
            || assemblyName is "mscorlib" or "netstandard")
        {
            return "bcl-framework";
        }
        return "third-party";
    }

    private static bool IsTestMethodTarget(IMethodSymbol target, Dictionary<IMethodSymbol, MethodDeclarationSyntax> seenTestMethods)
    {
        if (seenTestMethods.ContainsKey(target)) return true;
        return target.GetAttributes().Any(attribute =>
        {
            string name = attribute.AttributeClass?.Name ?? "";
            return name is "FactAttribute" or "TheoryAttribute";
        });
    }

    private static MethodFacts BuildMethodFacts(
        IMethodSymbol method,
        MethodDeclarationSyntax methodDeclaration,
        SemanticModel semanticModel,
        string file,
        Dictionary<IMethodSymbol, MethodDeclarationSyntax> seenTestMethods,
        List<string> unresolved)
    {
        var facts = new MethodFacts();
        if (methodDeclaration.Body is null) return facts;

        foreach (InvocationExpressionSyntax invocation in methodDeclaration.Body.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" })
            {
                continue;
            }
            var symbolInfo = semanticModel.GetSymbolInfo(invocation);
            if (symbolInfo.Symbol is IMethodSymbol target)
            {
                var fact = new MethodFact
                {
                    MethodName = target.Name,
                    ContainingType = target.ContainingType?.ToDisplayString() ?? "",
                    Assembly = target.ContainingAssembly?.Name ?? "",
                    AssemblyKind = AssemblyKind(target),
                    CallsTestMethod = IsTestMethodTarget(target, seenTestMethods),
                    Location = GetSpan(invocation, methodDeclaration.SyntaxTree)
                };
                facts.Invocations.Add(fact);
                if (IsAssertionCandidate(target))
                {
                    facts.AssertionCandidates.Add(fact);
                }
                if (fact.AssemblyKind == "production")
                {
                    facts.ProductionSymbolReferences.Add(fact);
                }
                if (fact.CallsTestMethod && target.ContainingAssembly?.Name != "FsusBlog.Server.Tests")
                {
                    fact.CalledTestMethodId = $"test-method:{target.ContainingType?.Name}.{target.Name}";
                }
            }
            else if (symbolInfo.Symbol is null && symbolInfo.CandidateSymbols.Length == 0)
            {
                unresolved.Add($"{file}:{method.Name}:unresolved invocation {invocation}");
            }
        }

        foreach (ReturnStatementSyntax returnStatement in methodDeclaration.Body.DescendantNodes().OfType<ReturnStatementSyntax>())
        {
            facts.ReturnStatements.Add(returnStatement.ToString());
        }

        foreach (AttributeSyntax attributeSyntax in methodDeclaration.AttributeLists.SelectMany(list => list.Attributes))
        {
            var symbolInfo = semanticModel.GetSymbolInfo(attributeSyntax);
            if (symbolInfo.Symbol is IMethodSymbol attributeConstructor)
            {
                facts.TestAttributeReferences.Add(new MethodFact
                {
                    MethodName = attributeConstructor.ContainingType?.Name ?? attributeSyntax.Name.ToString(),
                    ContainingType = attributeConstructor.ContainingType?.ToDisplayString() ?? "",
                    Assembly = attributeConstructor.ContainingAssembly?.Name ?? "",
                    AssemblyKind = AssemblyKind(attributeConstructor),
                    Location = GetSpan(attributeSyntax, methodDeclaration.SyntaxTree)
                });
            }
        }

        facts.Invocations.Sort((left, right) => string.CompareOrdinal(left.MethodName, right.MethodName));
        facts.AssertionCandidates.Sort((left, right) => string.CompareOrdinal(left.MethodName, right.MethodName));
        facts.ProductionSymbolReferences.Sort((left, right) => string.CompareOrdinal(left.MethodName, right.MethodName));
        facts.TestAttributeReferences.Sort((left, right) => string.CompareOrdinal(left.MethodName, right.MethodName));
        facts.ReturnStatements.Sort(StringComparer.Ordinal);
        return facts;
    }

    private static bool IsAssertionCandidate(IMethodSymbol target)
    {
        string name = target.Name;
        if (name.StartsWith("Assert", StringComparison.Ordinal)) return true;
        if (name.StartsWith("Should", StringComparison.Ordinal)) return true;
        string containing = target.ContainingType?.ToDisplayString() ?? "";
        return containing == "Xunit.Assert"
            || containing.StartsWith("FluentAssertions", StringComparison.Ordinal)
            || name is "expect" or "assert";
    }

    public static void WriteReport(Result result)
    {
        string json = JsonSerializer.Serialize(result, s_jsonOptions);
        Console.WriteLine(json);
    }
}
