using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ContentFieldContractAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor s_failure = new(
        "FSUSBLOGCFC001",
        "Content field contract extraction failed",
        "Content field contract extraction failed: {0}",
        "FsusBlog.Build",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        customTags: [WellKnownDiagnosticTags.CompilationEnd]);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => [s_failure];

    public override void Initialize(AnalysisContext context)
    {
        context.EnableConcurrentExecution();
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.Analyze);
        context.RegisterCompilationAction(ExtractAtCompilationEnd);
    }

    private static void ExtractAtCompilationEnd(CompilationAnalysisContext context)
    {
        try
        {
            if (!context.Options.AnalyzerConfigOptionsProvider.GlobalOptions.TryGetValue(
                "build_property.FsusBlogContentFieldContractOutput",
                out string? output)
                || string.IsNullOrWhiteSpace(output))
            {
                throw new InvalidOperationException("FsusBlogContentFieldContractOutput is missing");
            }
            Diagnostic[] diagnostics = context.Compilation.GetDiagnostics(context.CancellationToken)
                .Where(diagnostic => diagnostic.Severity is DiagnosticSeverity.Warning or DiagnosticSeverity.Error)
                .Take(20)
                .ToArray();
            if (diagnostics.Length > 0)
            {
                throw new InvalidOperationException("production compilation has diagnostics: "
                    + string.Join(" | ", diagnostics.Select(diagnostic => diagnostic.ToString())));
            }
            ContentFieldContractExtractor.Extraction extraction = ContentFieldContractExtractor.Extract((CSharpCompilation)context.Compilation);
            string fullOutput = Path.GetFullPath(output);
            Directory.CreateDirectory(Path.GetDirectoryName(fullOutput)
                ?? throw new InvalidOperationException("extractor output directory is missing"));
            File.WriteAllText(fullOutput, JsonSerializer.Serialize(extraction, ContentFieldContractExtractor.JsonOptions));
        }
        catch (Exception error)
        {
            context.ReportDiagnostic(Diagnostic.Create(s_failure, Location.None, error.Message));
        }
    }
}

internal static class ContentFieldContractExtractor
{
    private const string ArticlePath = "src/backend/Services/Articles/ArticlePublicationValidator.cs";
    private const string CommentPath = "src/backend/Models/Dtos/CommentDto.cs";
    private const string EndpointPath = "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs";

    public static JsonSerializerOptions JsonOptions
    {
        get;
    } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static Extraction Extract(CSharpCompilation compilation)
    {
        SyntaxTree articleTree = AuthorityTree(compilation, ArticlePath);
        SyntaxTree commentTree = AuthorityTree(compilation, CommentPath);
        SyntaxTree endpointTree = AuthorityTree(compilation, EndpointPath);
        var contexts = new Dictionary<string, SourceContext>
        {
            [ArticlePath] = new(articleTree.GetCompilationUnitRoot(), compilation.GetSemanticModel(articleTree)),
            [CommentPath] = new(commentTree.GetCompilationUnitRoot(), compilation.GetSemanticModel(commentTree)),
            [EndpointPath] = new(endpointTree.GetCompilationUnitRoot(), compilation.GetSemanticModel(endpointTree))
        };

        ArticleExtraction article = ExtractArticle(contexts[ArticlePath]);
        CommentExtraction comment = ExtractComment(contexts[CommentPath]);
        EndpointExtraction endpoint = ExtractEndpoint(contexts[EndpointPath]);
        return new Extraction(
            "fsusblog.content-field-roslyn-extraction.v2",
            CompilationContract(compilation),
            article,
            comment,
            endpoint);
    }

    private static SyntaxTree AuthorityTree(CSharpCompilation compilation, string relative)
    {
        string suffix = relative.Replace('/', Path.DirectorySeparatorChar);
        SyntaxTree[] matches = compilation.SyntaxTrees
            .Where(tree => Path.GetFullPath(tree.FilePath).EndsWith(suffix, StringComparison.Ordinal))
            .ToArray();
        Require(matches.Length == 1, $"expected exactly one active production tree for {relative}");
        return matches[0];
    }

    private static CompilationIdentity CompilationContract(CSharpCompilation compilation)
    {
        ParseIdentity[] parseOptions = compilation.SyntaxTrees
            .Select(tree => (CSharpParseOptions)tree.Options)
            .Select(options => new ParseIdentity(
                options.LanguageVersion.ToString(),
                options.PreprocessorSymbolNames.Order(StringComparer.Ordinal).ToArray(),
                options.Features.OrderBy(item => item.Key, StringComparer.Ordinal)
                    .Select(item => $"{item.Key}={item.Value}").ToArray()))
            .DistinctBy(options => JsonSerializer.Serialize(options))
            .OrderBy(options => JsonSerializer.Serialize(options), StringComparer.Ordinal)
            .ToArray();
        var references = compilation.References.Select(reference =>
        {
            ISymbol? symbol = compilation.GetAssemblyOrModuleSymbol(reference);
            string display = reference.Display ?? throw new InvalidOperationException("production metadata reference has no display path");
            Require(File.Exists(display), $"production metadata reference is not a file: {display}");
            return new ReferenceIdentity(
                symbol switch
                {
                    IAssemblySymbol assembly => assembly.Identity.ToString(),
                    IModuleSymbol module => module.Name,
                    _ => throw new InvalidOperationException($"cannot resolve production metadata reference {display}")
                },
                Path.GetFileName(display),
                FileSha256(display));
        }).OrderBy(reference => reference.Identity, StringComparer.Ordinal)
            .ThenBy(reference => reference.FileName, StringComparer.Ordinal)
            .ToArray();
        return new CompilationIdentity(
            compilation.AssemblyName ?? throw new InvalidOperationException("production compilation assembly name is missing"),
            compilation.Options.OutputKind.ToString(),
            compilation.Options.OptimizationLevel.ToString(),
            compilation.Options.NullableContextOptions.ToString(),
            compilation.Options.Platform.ToString(),
            compilation.Options.AllowUnsafe,
            compilation.Options.CheckOverflow,
            compilation.Options.MainTypeName,
            compilation.Options.ScriptClassName,
            compilation.Options.Usings.Order(StringComparer.Ordinal).ToArray(),
            compilation.Options.GeneralDiagnosticOption.ToString(),
            compilation.Options.WarningLevel,
            compilation.Options.SpecificDiagnosticOptions.OrderBy(item => item.Key, StringComparer.Ordinal)
                .Select(item => $"{item.Key}={item.Value}").ToArray(),
            compilation.Options.ConcurrentBuild,
            compilation.Options.Deterministic,
            compilation.Options.PublicSign,
            compilation.Options.ReportSuppressedDiagnostics,
            compilation.Options.MetadataImportOptions.ToString(),
            compilation.Options.ReferencesSupersedeLowerVersions,
            parseOptions,
            references,
            new RuntimeIdentity(
                RuntimeInformation.FrameworkDescription,
                Environment.Version.ToString(),
                typeof(Compilation).Assembly.FullName ?? string.Empty,
                typeof(Compilation).Assembly.ManifestModule.ModuleVersionId.ToString("D"),
                typeof(CSharpCompilation).Assembly.FullName ?? string.Empty,
                typeof(CSharpCompilation).Assembly.ManifestModule.ModuleVersionId.ToString("D")));
    }

    private static string FileSha256(string file)
    {
        using FileStream stream = File.OpenRead(file);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static ArticleExtraction ExtractArticle(SourceContext context)
    {
        RecordDeclarationSyntax input = TopLevelType<RecordDeclarationSyntax>(context.Root, "ArticlePublicationValidationInput");
        ClassDeclarationSyntax owner = TopLevelType<ClassDeclarationSyntax>(context.Root, "ArticlePublicationValidator");
        INamedTypeSymbol ownerSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(owner), "ArticlePublicationValidator");
        MethodDeclarationSyntax method = DirectMethod(
            owner,
            context.Model,
            "AddContentIssues",
            ["ArticlePublicationValidationInput", "DateTime", "List<PrepublishIssue>"]);
        IMethodSymbol methodSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(method), "AddContentIssues");
        Require(methodSymbol.ContainingType.Equals(ownerSymbol, SymbolEqualityComparer.Default), "AddContentIssues declaring type drifted");

        INamedTypeSymbol inputSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(input), "ArticlePublicationValidationInput");
        Dictionary<string, ParameterContract> parameters = input.ParameterList?.Parameters.ToDictionary(
            parameter => parameter.Identifier.ValueText,
            parameter =>
            {
                IParameterSymbol parameterSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(parameter), parameter.Identifier.ValueText);
                IPropertySymbol propertySymbol = inputSymbol.GetMembers(parameter.Identifier.ValueText).OfType<IPropertySymbol>().Single();
                return new ParameterContract(
                    SymbolIdentity(parameterSymbol.Type),
                    parameterSymbol.NullableAnnotation == NullableAnnotation.Annotated,
                    SymbolIdentity(propertySymbol),
                    AttributeFacts(propertySymbol, context.Model));
            })
            ?? throw new InvalidOperationException("ArticlePublicationValidationInput primary parameters are missing");
        Dictionary<string, ConstantContract> constants = DirectIntegerConstants(owner, ownerSymbol, context.Model, [
            "MaxTitleLength", "MaxSummaryLength", "MaxContentLength"
        ]);
        var actions = ownerSymbol.GetMembers().OfType<IMethodSymbol>()
            .Where(symbol => symbol.MethodKind == MethodKind.Ordinary
                && symbol.Name is "AddError" or "AddWarning"
                && symbol.Parameters.Length == 3)
            .ToDictionary(symbol => symbol.Name, StringComparer.Ordinal);

        var fields = new[]
        {
            ArticleField(context.Model, method, parameters, constants, actions, "article.body", "Content", "body"),
            ArticleField(context.Model, method, parameters, constants, actions, "article.summary", "Summary", "summary"),
            ArticleField(context.Model, method, parameters, constants, actions, "article.title", "Title", "title")
        };
        return new ArticleExtraction(ownerSymbol.ToDisplayString(), MethodSignature(methodSymbol), fields);
    }

    private static ArticleFieldContract ArticleField(
        SemanticModel model,
        MethodDeclarationSyntax method,
        IReadOnlyDictionary<string, ParameterContract> parameters,
        IReadOnlyDictionary<string, ConstantContract> constants,
        IReadOnlyDictionary<string, IMethodSymbol> actions,
        string id,
        string inputMember,
        string localName)
    {
        VariableDeclaratorSyntax declarator = method.DescendantNodes().OfType<VariableDeclaratorSyntax>()
            .Single(item => item.Identifier.ValueText == localName);
        ILocalSymbol local = RequireSymbol(model.GetDeclaredSymbol(declarator) as ILocalSymbol, localName);
        ExpressionSyntax initializer = declarator.Initializer?.Value
            ?? throw new InvalidOperationException($"{localName} initializer is missing");
        IfStatementSyntax emptyBranch = method.DescendantNodes().OfType<IfStatementSyntax>()
            .Where(item => !item.Ancestors().OfType<IfStatementSyntax>().Any(parent => parent.Else?.Statement == item))
            .Single(item => IsEmptyCondition(item.Condition, local, model));
        IfStatementSyntax maximumBranch = emptyBranch.Else?.Statement as IfStatementSyntax
            ?? throw new InvalidOperationException($"{localName} maximum validation is no longer the direct else-if");
        BinaryExpressionSyntax maximumCondition = maximumBranch.Condition as BinaryExpressionSyntax
            ?? throw new InvalidOperationException($"{localName} maximum validation condition is unsupported");
        Require(ReferencesLocalLength(maximumCondition.Left, local, model), $"{localName} maximum validation no longer reads local Length");
        IFieldSymbol maximumSymbol = model.GetSymbolInfo(maximumCondition.Right).Symbol as IFieldSymbol
            ?? throw new InvalidOperationException($"{localName} maximum validation does not reference a field symbol");
        string constantName = maximumSymbol.Name;
        Require(constants.TryGetValue(constantName, out ConstantContract? constant)
            && constant.Symbol == SymbolIdentity(maximumSymbol),
            $"{localName} maximum does not reference the exact ArticlePublicationValidator constant symbol");
        IMethodSymbol? emptyActionSymbol = emptyBranch.Statement.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Select(invocation => model.GetSymbolInfo(invocation).Symbol as IMethodSymbol)
            .FirstOrDefault(symbol => symbol is not null
                && actions.TryGetValue(symbol.Name, out IMethodSymbol? expected)
                && SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition, expected.OriginalDefinition));
        string emptyAction = emptyActionSymbol?.Name ?? "none";
        return new ArticleFieldContract(
            id,
            inputMember,
            parameters[inputMember],
            SemanticCanonical(initializer, model),
            Normalization(initializer, model),
            LocalDataflow(method, declarator, local, model, [emptyBranch.Condition, maximumBranch.Condition]),
            new BranchContract(
                SemanticCanonical(emptyBranch.Condition, model),
                emptyAction,
                emptyActionSymbol is null ? null : SymbolIdentity(emptyActionSymbol),
                SemanticCanonical(maximumBranch.Condition, model),
                maximumCondition.OperatorToken.ValueText,
                "if-else-if"),
            new NamedConstantContract(constantName, constant!));
    }

    private static CommentExtraction ExtractComment(SourceContext context)
    {
        ClassDeclarationSyntax limits = TopLevelType<ClassDeclarationSyntax>(context.Root, "CommentLimits");
        RecordDeclarationSyntax dto = TopLevelType<RecordDeclarationSyntax>(context.Root, "CommentDto");
        INamedTypeSymbol limitsSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(limits), "CommentLimits");
        INamedTypeSymbol dtoSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(dto), "CommentDto");
        PropertyDeclarationSyntax content = dto.Members.OfType<PropertyDeclarationSyntax>()
            .Single(property => property.Identifier.ValueText == "Content");
        IPropertySymbol contentSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(content), "CommentDto.Content");
        Require(contentSymbol.ContainingType.Equals(dtoSymbol, SymbolEqualityComparer.Default), "Content property declaring type drifted");

        string[] constantNames = [
            "ContentMinChars", "ContentMinUtf8Bytes", "DefaultContentMaxChars", "DefaultContentMaxUtf8Bytes",
            "HardContentMaxChars", "HardContentMaxUtf8Bytes", "ContentMaxChars", "ContentMaxUtf8Bytes"
        ];
        Dictionary<string, ConstantContract> constants = DirectIntegerConstants(limits, limitsSymbol, context.Model, constantNames);
        var methods = new[]
        {
            DirectMethodContract(limits, context.Model, limitsSymbol, "NormalizeMaxChars", ["int?"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "NormalizeMaxUtf8Bytes", ["int?"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "ValidateMaxChars", ["int"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "ValidateMaxUtf8Bytes", ["int"])
        };
        AttributeContract[] attributes = AttributeFacts(contentSymbol, context.Model);
        var property = new PropertyContract(
            SymbolIdentity(contentSymbol),
            SymbolIdentity(contentSymbol.Type),
            contentSymbol.NullableAnnotation == NullableAnnotation.Annotated,
            content.Modifiers.Any(SyntaxKind.RequiredKeyword),
            attributes);
        return new CommentExtraction(
            $"{limitsSymbol.ToDisplayString()}+{contentSymbol.ToDisplayString()}",
            property,
            constants,
            methods);
    }

    private static EndpointExtraction ExtractEndpoint(SourceContext context)
    {
        ClassDeclarationSyntax owner = TopLevelType<ClassDeclarationSyntax>(context.Root, "BinaryEndpoints");
        INamedTypeSymbol ownerSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(owner), "BinaryEndpoints");
        MethodDeclarationSyntax predicateDeclaration = DirectMethod(
            owner,
            context.Model,
            "IsCommentContentWithinLimit",
            ["string", "AnonymousCommentPolicySnapshot"]);
        IMethodSymbol predicateSymbol = RequireSymbol(context.Model.GetDeclaredSymbol(predicateDeclaration), "IsCommentContentWithinLimit");
        Require(predicateSymbol.ContainingType.Equals(ownerSymbol, SymbolEqualityComparer.Default), "comment predicate declaring type drifted");
        IParameterSymbol contentParameter = predicateSymbol.Parameters[0];
        ExpressionSyntax predicateExpression = predicateDeclaration.ExpressionBody?.Expression
            ?? throw new InvalidOperationException("comment predicate must remain expression-bodied");
        BinaryExpressionSyntax characterClause = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Single(expression => ReferencesStringLength(expression.Left, contentParameter, context.Model));
        BinaryExpressionSyntax utf8Clause = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Single(expression => expression.Left is InvocationExpressionSyntax invocation
                && IsUtf8ByteCount(invocation, contentParameter, context.Model));
        string[] connectors = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Where(expression => expression.IsKind(SyntaxKind.LogicalAndExpression) || expression.IsKind(SyntaxKind.LogicalOrExpression))
            .OrderBy(expression => expression.OperatorToken.SpanStart)
            .Select(expression => expression.OperatorToken.ValueText)
            .ToArray();
        bool nonWhitespace = predicateExpression.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Any(invocation => IsStringIsNullOrWhiteSpace(invocation, contentParameter, context.Model));
        IPropertySymbol characterLimit = context.Model.GetSymbolInfo(characterClause.Right).Symbol as IPropertySymbol
            ?? throw new InvalidOperationException("comment character limit is not a property symbol");
        IPropertySymbol utf8Limit = context.Model.GetSymbolInfo(utf8Clause.Right).Symbol as IPropertySymbol
            ?? throw new InvalidOperationException("comment UTF-8 limit is not a property symbol");
        var predicate = new PredicateContract(
            SemanticCanonical(predicateExpression, context.Model),
            connectors,
            nonWhitespace,
            characterClause.OperatorToken.ValueText,
            SymbolIdentity(characterLimit),
            utf8Clause.OperatorToken.ValueText,
            SymbolIdentity(utf8Limit));

        VariableDeclaratorSyntax[] contentDeclarations = owner.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Where(declaration => declaration.Identifier.ValueText == "content"
                && declaration.Initializer?.Value.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>()
                    .Any(access => context.Model.GetSymbolInfo(access).Symbol is IPropertySymbol property
                        && property.Name == "Content") == true)
            .ToArray();
        Require(contentDeclarations.Length > 0, "comment endpoint content initializer is missing");
        var flows = contentDeclarations.Select(declaration =>
        {
            ILocalSymbol local = RequireSymbol(context.Model.GetDeclaredSymbol(declaration) as ILocalSymbol, "endpoint content");
            SyntaxNode flowScope = declaration.Ancestors().FirstOrDefault(node => node is AnonymousFunctionExpressionSyntax or MethodDeclarationSyntax)
                ?? throw new InvalidOperationException("comment endpoint content flow scope is missing");
            ExpressionSyntax initializer = declaration!.Initializer?.Value
                ?? throw new InvalidOperationException("comment endpoint content initializer is missing");
            InvocationExpressionSyntax[] sinks = flowScope.DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(invocation => SymbolEqualityComparer.Default.Equals(
                    context.Model.GetSymbolInfo(invocation).Symbol,
                    predicateSymbol)
                    && invocation.ArgumentList.Arguments.Any(argument => ReferencesSymbol(argument.Expression, local, context.Model)))
                .ToArray();
            Require(sinks.Length == 1, "each comment content flow must reach exactly one predicate invocation");
            return new EndpointFlowContract(
                SemanticCanonical(initializer, context.Model),
                Normalization(initializer, context.Model),
                LocalDataflow(flowScope, declaration, local, context.Model, sinks));
        }).ToArray();
        return new EndpointExtraction(ownerSymbol.ToDisplayString(), MethodSignature(predicateSymbol), flows, predicate);
    }

    private static MethodContract DirectMethodContract(
        TypeDeclarationSyntax owner,
        SemanticModel model,
        INamedTypeSymbol ownerSymbol,
        string name,
        string[] parameterTypes)
    {
        MethodDeclarationSyntax declaration = DirectMethod(owner, model, name, parameterTypes);
        IMethodSymbol symbol = RequireSymbol(model.GetDeclaredSymbol(declaration), name);
        Require(symbol.ContainingType.Equals(ownerSymbol, SymbolEqualityComparer.Default), $"{name} declaring type drifted");
        return new MethodContract(MethodSignature(symbol), SemanticCanonical(
            declaration.Body ?? (SyntaxNode?)declaration.ExpressionBody?.Expression
                ?? throw new InvalidOperationException($"{name} body is missing"),
            model));
    }

    private static MethodDeclarationSyntax DirectMethod(
        TypeDeclarationSyntax owner,
        SemanticModel model,
        string name,
        string[] parameterTypes)
    {
        MethodDeclarationSyntax[] matches = owner.Members.OfType<MethodDeclarationSyntax>()
            .Where(method => method.Identifier.ValueText == name
                && model.GetDeclaredSymbol(method) is IMethodSymbol symbol
                && symbol.Parameters.Select(parameter => MinimallyQualifiedType(parameter.Type)).SequenceEqual(parameterTypes))
            .ToArray();
        Require(matches.Length == 1, $"expected exactly one {owner.Identifier.ValueText}.{name}({string.Join(",", parameterTypes)}) declaration");
        Require(model.GetDeclaredSymbol(matches[0]) is not null, $"cannot resolve symbol for {name}");
        return matches[0];
    }

    private static T TopLevelType<T>(CompilationUnitSyntax root, string name) where T : TypeDeclarationSyntax
    {
        T[] matches = root.DescendantNodes().OfType<T>()
            .Where(type => type.Identifier.ValueText == name && !type.Ancestors().OfType<TypeDeclarationSyntax>().Any())
            .ToArray();
        Require(matches.Length == 1, $"expected exactly one active top-level {name} declaration");
        return matches[0];
    }

    private static Dictionary<string, ConstantContract> DirectIntegerConstants(
        TypeDeclarationSyntax owner,
        INamedTypeSymbol ownerSymbol,
        SemanticModel model,
        IEnumerable<string> names)
    {
        Dictionary<string, VariableDeclaratorSyntax> declarations = owner.Members.OfType<FieldDeclarationSyntax>()
            .Where(field => field.Modifiers.Any(SyntaxKind.PublicKeyword)
                && field.Modifiers.Any(SyntaxKind.ConstKeyword)
                && Canonical(field.Declaration.Type) == "int")
            .SelectMany(field => field.Declaration.Variables)
            .ToDictionary(variable => variable.Identifier.ValueText);
        var result = new Dictionary<string, ConstantContract>();
        foreach (string name in names)
        {
            if (!declarations.TryGetValue(name, out VariableDeclaratorSyntax? declaration))
            {
                throw new InvalidOperationException($"direct integer constant {owner.Identifier.ValueText}.{name} is missing");
            }
            ExpressionSyntax initializer = declaration.Initializer?.Value
                ?? throw new InvalidOperationException($"constant {name} initializer is missing");
            Optional<object?> value = model.GetConstantValue(initializer);
            Require(value.HasValue && value.Value is int, $"constant {name} does not resolve to an integer");
            IFieldSymbol symbol = RequireSymbol(model.GetDeclaredSymbol(declaration) as IFieldSymbol, $"{owner.Identifier.ValueText}.{name}");
            Require(symbol.ContainingType.Equals(ownerSymbol, SymbolEqualityComparer.Default), $"constant {name} declaring type drifted");
            result[name] = new ConstantContract(SemanticCanonical(initializer, model), (int)value.Value!, SymbolIdentity(symbol));
        }
        return result;
    }

    private static string[] LocalDataflow(
        SyntaxNode scope,
        VariableDeclaratorSyntax declaration,
        ILocalSymbol local,
        SemanticModel model,
        IEnumerable<SyntaxNode> sinks)
    {
        var facts = new List<(int Position, string Fact)>
        {
            (declaration.SpanStart, $"declare {SemanticCanonical(declaration.Initializer?.Value
                ?? throw new InvalidOperationException($"{local.Name} initializer is missing"), model)}")
        };
        var tracked = new HashSet<ISymbol>(SymbolEqualityComparer.Default) { local };
        bool changed;
        do
        {
            changed = false;
            foreach (VariableDeclaratorSyntax alias in scope.DescendantNodes().OfType<VariableDeclaratorSyntax>())
            {
                if (alias.Initializer?.Value is not RefExpressionSyntax reference
                    || !ReferencesAnySymbol(reference.Expression, tracked, model))
                    continue;
                ILocalSymbol aliasSymbol = RequireSymbol(model.GetDeclaredSymbol(alias) as ILocalSymbol, alias.Identifier.ValueText);
                changed |= tracked.Add(aliasSymbol);
            }
        }
        while (changed);

        var selected = new List<SyntaxNode>();
        selected.AddRange(sinks);
        selected.AddRange(scope.DescendantNodes().OfType<AssignmentExpressionSyntax>()
            .Where(assignment => ReferencesAnySymbol(assignment.Left, tracked, model)));
        selected.AddRange(scope.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .Where(invocation => invocation.ArgumentList.Arguments.Any(argument =>
                argument.RefKindKeyword.Kind() is SyntaxKind.RefKeyword or SyntaxKind.OutKeyword
                && ReferencesAnySymbol(argument.Expression, tracked, model))));
        selected.AddRange(scope.DescendantNodes().OfType<VariableDeclaratorSyntax>()
            .Where(candidate => model.GetDeclaredSymbol(candidate) is ILocalSymbol symbol && tracked.Contains(symbol))
            .Select(candidate => candidate.Initializer?.Value).OfType<ExpressionSyntax>());
        var visitedMethods = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        foreach (SyntaxNode selectedNode in selected.Distinct())
        {
            facts.Add((selectedNode.SpanStart, $"slice {SemanticCanonical(selectedNode, model)}"));
            foreach (string dependency in SourceDependencyFacts(selectedNode, model, visitedMethods))
                facts.Add((selectedNode.SpanStart, dependency));
        }
        return facts.OrderBy(fact => fact.Position).ThenBy(fact => fact.Fact, StringComparer.Ordinal)
            .Select(fact => fact.Fact).Distinct(StringComparer.Ordinal).ToArray();
    }

    private static bool IsEmptyCondition(ExpressionSyntax condition, ILocalSymbol local, SemanticModel model)
    {
        if (condition is BinaryExpressionSyntax binary
            && binary.IsKind(SyntaxKind.EqualsExpression)
            && ReferencesLocalLength(binary.Left, local, model)
            && model.GetConstantValue(binary.Right) is { HasValue: true, Value: 0 })
        {
            return true;
        }
        return condition is InvocationExpressionSyntax invocation
            && IsStringIsNullOrWhiteSpace(invocation, local, model);
    }

    private static bool ReferencesLocalLength(ExpressionSyntax expression, ILocalSymbol local, SemanticModel model)
        => ReferencesStringLength(expression, local, model);

    private static bool ReferencesStringLength(ExpressionSyntax expression, ISymbol receiver, SemanticModel model)
        => expression is MemberAccessExpressionSyntax access
            && model.GetSymbolInfo(access).Symbol is IPropertySymbol property
            && property.Name == "Length"
            && property.ContainingType.SpecialType == SpecialType.System_String
            && ReferencesSymbol(access.Expression, receiver, model);

    private static bool IsStringIsNullOrWhiteSpace(InvocationExpressionSyntax invocation, ISymbol argument, SemanticModel model)
        => model.GetSymbolInfo(invocation).Symbol is IMethodSymbol method
            && method.Name == "IsNullOrWhiteSpace"
            && method.ContainingType.SpecialType == SpecialType.System_String
            && method.Parameters.Length == 1
            && invocation.ArgumentList.Arguments.Any(item => ReferencesSymbol(item.Expression, argument, model));

    private static bool IsUtf8ByteCount(InvocationExpressionSyntax invocation, ISymbol argument, SemanticModel model)
    {
        if (model.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method
            || method.Name != "GetByteCount"
            || !IsFrameworkType(method.ContainingType, "System.Text.Encoding")
            || method.Parameters.Length != 1
            || !invocation.ArgumentList.Arguments.Any(item => ReferencesSymbol(item.Expression, argument, model)))
        {
            return false;
        }
        return invocation.Expression is MemberAccessExpressionSyntax access
            && model.GetSymbolInfo(access.Expression).Symbol is IPropertySymbol receiver
            && receiver.Name == "UTF8"
            && IsFrameworkType(receiver.ContainingType, "System.Text.Encoding");
    }

    private static bool ReferencesSymbol(SyntaxNode node, ISymbol symbol, SemanticModel model)
        => node.DescendantNodesAndSelf().Any(candidate => SymbolEqualityComparer.Default.Equals(
            model.GetSymbolInfo(candidate).Symbol,
            symbol));

    private static bool ReferencesAnySymbol(SyntaxNode node, IEnumerable<ISymbol> symbols, SemanticModel model)
    {
        var expected = new HashSet<ISymbol>(symbols, SymbolEqualityComparer.Default);
        return node.DescendantNodesAndSelf().Any(candidate => model.GetSymbolInfo(candidate).Symbol is ISymbol symbol
            && expected.Contains(symbol));
    }

    private static AttributeContract[] AttributeFacts(ISymbol symbol, SemanticModel model)
        => symbol.GetAttributes().Select(attribute =>
        {
            INamedTypeSymbol attributeClass = attribute.AttributeClass
                ?? throw new InvalidOperationException($"attribute on {symbol.Name} has no class symbol");
            string arguments = string.Join(" , ", attribute.ConstructorArguments.Select(TypedConstantFact));
            string? firstArgument = null;
            if (attribute.ApplicationSyntaxReference?.GetSyntax() is AttributeSyntax syntax
                && syntax.ArgumentList?.Arguments.FirstOrDefault()?.Expression is ExpressionSyntax expression)
            {
                ISymbol? referenced = model.GetSymbolInfo(expression).Symbol;
                firstArgument = referenced is null
                    ? attribute.ConstructorArguments.FirstOrDefault() is TypedConstant value ? TypedConstantFact(value) : null
                    : SymbolIdentity(referenced);
            }
            return new AttributeContract(
                SymbolIdentity(attributeClass),
                attributeClass.ContainingAssembly.Identity.ToString(),
                arguments.Length == 0 ? null : arguments,
                firstArgument);
        }).OrderBy(attribute => attribute.Name, StringComparer.Ordinal).ToArray();

    private static string TypedConstantFact(TypedConstant value)
        => value.Kind == TypedConstantKind.Array
            ? $"array[{string.Join(",", value.Values.Select(TypedConstantFact))}]"
            : $"{SymbolIdentity(value.Type)}={value.Value ?? "null"}";

    private static string SemanticCanonical(SyntaxNode node, SemanticModel model)
    {
        IOperation operation = model.GetOperation(node)
            ?? throw new InvalidOperationException($"cannot resolve operation for {node.Kind()}");
        return string.Join(" | ", OperationTree(operation).Select(OperationFact));
    }

    private static IEnumerable<IOperation> OperationTree(IOperation operation)
    {
        if (operation is IInvocationOperation invocation && IsKeepAlive(invocation.TargetMethod))
            yield break;
        yield return operation;
        foreach (IOperation child in operation.ChildOperations)
        {
            foreach (IOperation descendant in OperationTree(child))
                yield return descendant;
        }
    }

    private static string OperationFact(IOperation operation)
        => operation switch
        {
            IInvocationOperation invocation => $"invoke:{SymbolIdentity(invocation.TargetMethod)}",
            IFieldReferenceOperation field => $"field:{SymbolIdentity(field.Field)}",
            IPropertyReferenceOperation property => $"property:{SymbolIdentity(property.Property)}",
            IMethodReferenceOperation method => $"method:{SymbolIdentity(method.Method)}",
            ILocalReferenceOperation local => $"local:{SymbolIdentity(local.Local)}",
            IParameterReferenceOperation parameter => $"parameter:{SymbolIdentity(parameter.Parameter)}",
            IAnonymousFunctionOperation function => $"lambda:{SymbolIdentity(function.Symbol)}",
            IBinaryOperation binary => $"binary:{binary.OperatorKind}:{SymbolIdentity(binary.Type)}",
            IUnaryOperation unary => $"unary:{unary.OperatorKind}:{SymbolIdentity(unary.Type)}",
            IConversionOperation conversion => $"convert:{conversion.Conversion}:{SymbolIdentity(conversion.Type)}",
            ILiteralOperation literal when literal.ConstantValue.HasValue && literal.ConstantValue.Value is string or char
                => $"literal:{SymbolIdentity(literal.Type)}:<literal>",
            ILiteralOperation literal => $"literal:{SymbolIdentity(literal.Type)}:{literal.ConstantValue.Value ?? "null"}",
            _ => $"{operation.Kind}:{SymbolIdentity(operation.Type)}"
        };

    private static IEnumerable<string> SourceDependencyFacts(
        SyntaxNode node,
        SemanticModel model,
        HashSet<IMethodSymbol> visited)
    {
        IOperation? root = model.GetOperation(node);
        if (root is null)
            yield break;
        foreach (IInvocationOperation invocation in OperationTree(root).OfType<IInvocationOperation>())
        {
            IMethodSymbol target = invocation.TargetMethod.OriginalDefinition;
            if (target.MethodKind == MethodKind.DelegateInvoke
                && invocation.Instance is ILocalReferenceOperation delegateLocal)
            {
                VariableDeclaratorSyntax? delegateDeclaration = node.SyntaxTree.GetRoot().DescendantNodes()
                    .OfType<VariableDeclaratorSyntax>()
                    .FirstOrDefault(candidate => SymbolEqualityComparer.Default.Equals(
                        model.GetDeclaredSymbol(candidate),
                        delegateLocal.Local));
                if (delegateDeclaration?.Initializer?.Value is ExpressionSyntax lambda)
                {
                    yield return $"delegate:{SemanticCanonical(lambda, model)}";
                    foreach (string nested in SourceDependencyFacts(lambda, model, visited))
                        yield return nested;
                }
            }
            if (target.DeclaringSyntaxReferences.Length == 0 || !visited.Add(target))
                continue;
            yield return $"helper:{SymbolIdentity(target)}";
            foreach (SyntaxReference reference in target.DeclaringSyntaxReferences)
            {
                SyntaxNode declaration = reference.GetSyntax();
                SemanticModel dependencyModel = model.Compilation.GetSemanticModel(declaration.SyntaxTree);
                SyntaxNode? body = declaration switch
                {
                    MethodDeclarationSyntax method => method.Body ?? (SyntaxNode?)method.ExpressionBody?.Expression,
                    LocalFunctionStatementSyntax local => local.Body ?? (SyntaxNode?)local.ExpressionBody?.Expression,
                    _ => null
                };
                if (body is null)
                    continue;
                yield return $"helper-slice:{SemanticCanonical(body, dependencyModel)}";
                foreach (string nested in SourceDependencyFacts(body, dependencyModel, visited))
                    yield return nested;
            }
        }
    }

    private static bool IsKeepAlive(IMethodSymbol method)
        => method.Name == "KeepAlive"
            && IsFrameworkType(method.ContainingType, "System.GC")
            && method.Parameters.Length == 1
            && method.Parameters[0].Type.SpecialType == SpecialType.System_Object;

    private static bool IsFrameworkType(INamedTypeSymbol type, string metadataName)
        => type.ToDisplayString() == metadataName
            && type.ContainingAssembly.Identity.Name == "System.Private.CoreLib";

    private static string Normalization(ExpressionSyntax initializer, SemanticModel model)
    {
        IMethodSymbol[] invocations = initializer.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Select(invocation => model.GetSymbolInfo(invocation).Symbol as IMethodSymbol)
            .OfType<IMethodSymbol>().ToArray();
        if (invocations.Any(symbol => symbol.ContainingType.SpecialType == SpecialType.System_String && symbol.Name == "Trim"))
            return "trim";
        if (invocations.Any(symbol => symbol.ContainingType.SpecialType == SpecialType.System_String && symbol.Name == "Normalize"))
            return "normalize";
        return "none";
    }

    private static string MethodSignature(IMethodSymbol symbol)
        => SymbolIdentity(symbol);

    private static string MinimallyQualifiedType(ITypeSymbol type)
        => type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)
            .Replace(" ", string.Empty, StringComparison.Ordinal);

    private static string SymbolIdentity(ISymbol? symbol)
        => symbol switch
        {
            null => "none",
            ILocalSymbol local => $"local:{SymbolIdentity(local.ContainingSymbol)}:{local.Name}:{SymbolIdentity(local.Type)}",
            IParameterSymbol parameter => $"parameter:{SymbolIdentity(parameter.ContainingSymbol)}:{parameter.Ordinal}:{SymbolIdentity(parameter.Type)}:{parameter.RefKind}",
            IMethodSymbol method => $"method:{method.ContainingType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}.{method.MetadataName}({string.Join(",", method.Parameters.Select(item => $"{item.RefKind}:{SymbolIdentity(item.Type)}"))}):{SymbolIdentity(method.ReturnType)}",
            IFieldSymbol field => $"field:{field.ContainingType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}.{field.MetadataName}:{SymbolIdentity(field.Type)}",
            IPropertySymbol property => $"property:{property.ContainingType.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}.{property.MetadataName}:{SymbolIdentity(property.Type)}",
            INamedTypeSymbol type => $"type:{type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}",
            _ => $"{symbol.Kind}:{symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}"
        };

    private static T RequireSymbol<T>(T? symbol, string label) where T : class, ISymbol
        => symbol ?? throw new InvalidOperationException($"cannot resolve declared symbol for {label}");

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static string Canonical(SyntaxNode node)
        => string.Join(" ", node.DescendantTokens().Select(CanonicalToken));

    private static string CanonicalToken(SyntaxToken token)
        => token.Kind() switch
        {
            SyntaxKind.StringLiteralToken or SyntaxKind.CharacterLiteralToken or SyntaxKind.InterpolatedStringTextToken => "<literal>",
            _ => token.ValueText
        };

    private sealed record SourceContext(CompilationUnitSyntax Root, SemanticModel Model);

    internal sealed record Extraction(
        string Schema,
        CompilationIdentity Compilation,
        ArticleExtraction Article,
        CommentExtraction Comment,
        EndpointExtraction Endpoint);
    internal sealed record CompilationIdentity(
        string AssemblyName,
        string OutputKind,
        string OptimizationLevel,
        string NullableContextOptions,
        string Platform,
        bool AllowUnsafe,
        bool CheckOverflow,
        string? MainTypeName,
        string ScriptClassName,
        string[] Usings,
        string GeneralDiagnosticOption,
        int WarningLevel,
        string[] SpecificDiagnosticOptions,
        bool ConcurrentBuild,
        bool Deterministic,
        bool PublicSign,
        bool ReportSuppressedDiagnostics,
        string MetadataImportOptions,
        bool ReferencesSupersedeLowerVersions,
        ParseIdentity[] ParseOptions,
        ReferenceIdentity[] References,
        RuntimeIdentity Runtime);
    internal sealed record ParseIdentity(string LanguageVersion, string[] PreprocessorSymbols, string[] Features);
    internal sealed record ReferenceIdentity(string Identity, string FileName, string Sha256);
    internal sealed record RuntimeIdentity(
        string FrameworkDescription,
        string EnvironmentVersion,
        string CodeAnalysisAssembly,
        string CodeAnalysisMvid,
        string CSharpAssembly,
        string CSharpMvid);
    internal sealed record ArticleExtraction(string Owner, string Method, ArticleFieldContract[] Fields);
    internal sealed record ArticleFieldContract(
        string Id,
        string InputMember,
        ParameterContract Input,
        string Initializer,
        string Normalization,
        string[] Dataflow,
        BranchContract Branch,
        NamedConstantContract Constant);
    internal sealed record ParameterContract(
        string Type,
        bool Nullable,
        string PropertySymbol,
        AttributeContract[] PropertyAttributes);
    internal sealed record BranchContract(
        string EmptyCondition,
        string EmptyAction,
        string? EmptyActionSymbol,
        string MaximumCondition,
        string MaximumOperator,
        string ControlFlow);
    internal sealed record NamedConstantContract(string Name, ConstantContract Contract);
    internal sealed record ConstantContract(string Expression, int Value, string Symbol);
    internal sealed record CommentExtraction(
        string Owner,
        PropertyContract Property,
        Dictionary<string, ConstantContract> Constants,
        MethodContract[] Methods);
    internal sealed record PropertyContract(
        string Declaration,
        string Type,
        bool Nullable,
        bool RequiredKeyword,
        AttributeContract[] Attributes);
    internal sealed record AttributeContract(string Name, string Assembly, string? Arguments, string? FirstArgument);
    internal sealed record MethodContract(string Signature, string Body);
    internal sealed record EndpointExtraction(
        string Owner,
        string Method,
        EndpointFlowContract[] Flows,
        PredicateContract Predicate);
    internal sealed record EndpointFlowContract(string Initializer, string Normalization, string[] Dataflow);
    internal sealed record PredicateContract(
        string Expression,
        string[] Connectors,
        bool NonWhitespace,
        string CharacterOperator,
        string CharacterLimit,
        string Utf8Operator,
        string Utf8Limit);
}
