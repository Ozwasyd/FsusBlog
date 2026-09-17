using System.Collections.Immutable;
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


internal static partial class XunitAdapterProgram
{
    public const string AdapterId = "xunit";
    public const string AdapterVersion = "xunit.v2";
    public const string ReportSchema = "fsusblog.test-inventory.xunit-roslyn.v1";

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
        bool allowUnsafeBlocks = ReadAllowUnsafeBlocks(projectPath);

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

        ResolvedReferenceContext referenceContext;
        try
        {
            referenceContext = BuildReferences(projectDir, projectPath);
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
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        foreach (string sourcePath in sources)
        {
            string relative = Path.GetRelativePath(root, sourcePath).Replace(Path.DirectorySeparatorChar, '/');
            string sourceText = File.ReadAllText(sourcePath);
            SyntaxTree tree = CSharpSyntaxTree.ParseText(sourceText, parseOptions, path: sourcePath);
            syntaxTrees.Add(tree);
            sourceByTree[tree.FilePath] = relative;
        }

        string assemblyName = Path.GetFileNameWithoutExtension(projectPath);
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            syntaxTrees,
            referenceContext.References,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithAllowUnsafe(allowUnsafeBlocks));

        ImmutableArray<Diagnostic> generatorDiagnostics;
        try
        {
            (compilation, generatorDiagnostics) = RunRegexSourceGenerator(
                compilation,
                parseOptions,
                referenceContext.NetCoreReferencePack);
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

        var compilationErrorDiagnostics = generatorDiagnostics
            .Concat(compilation.GetDiagnostics())
            .Where(item => item.Severity == DiagnosticSeverity.Error)
            .OrderBy(item => item.Location.SourceTree?.FilePath ?? "", StringComparer.Ordinal)
            .ThenBy(item => item.Location.SourceSpan.Start)
            .ThenBy(item => item.Id, StringComparer.Ordinal)
            .ToArray();
        if (compilationErrorDiagnostics.Length > 0)
        {
            string renderedDiagnostics = string.Join(
                " | ",
                compilationErrorDiagnostics.Take(40).Select(item => item.ToString()));
            string truncated = compilationErrorDiagnostics.Length > 40
                ? $" | ... {compilationErrorDiagnostics.Length - 40} more compilation errors"
                : "";
            result.Diagnostics.Add(new DiagnosticEntry
            {
                Severity = "error",
                Code = "xunit-semantic-model-incomplete",
                File = relativeProject,
                Message = $"semantic model is incomplete; compilation errors ({compilationErrorDiagnostics.Length}): {renderedDiagnostics}{truncated}"
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
                    bool isTheory = IsAttributeType(testAttribute!, "TheoryAttribute");

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
                        methodSymbol, testAttribute!, semanticModel, relativeFile, unresolvedSymbols);
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

    public static void WriteReport(Result result)
    {
        string json = JsonSerializer.Serialize(result, s_jsonOptions);
        Console.WriteLine(json);
    }
}
