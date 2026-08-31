using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: FsusBlog.ContentFieldContractExtractor <repository-root>");
    return 2;
}

try
{
    string root = Path.GetFullPath(args[0]);
    ContentFieldContractExtractor.Extraction extraction = ContentFieldContractExtractor.Extract(root);
    Console.WriteLine(JsonSerializer.Serialize(extraction, ContentFieldContractExtractor.JsonOptions));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine($"[content-field-contract-extractor] {error.Message}");
    return 1;
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

    public static Extraction Extract(string root)
    {
        var sources = new[] { ArticlePath, CommentPath, EndpointPath };
        var trees = sources.Select(relative => CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(root, relative)),
            new CSharpParseOptions(LanguageVersion.Latest, DocumentationMode.None, SourceCodeKind.Regular),
            path: relative)).ToArray();
        ImmutableArray<MetadataReference> references = TrustedPlatformReferences();
        CSharpCompilation compilation = CSharpCompilation.Create(
            "ContentFieldContractProjection",
            trees,
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var contexts = trees.ToDictionary(
            tree => tree.FilePath,
            tree => new SourceContext(tree.GetCompilationUnitRoot(), compilation.GetSemanticModel(tree)));

        ArticleExtraction article = ExtractArticle(contexts[ArticlePath]);
        CommentExtraction comment = ExtractComment(contexts[CommentPath]);
        EndpointExtraction endpoint = ExtractEndpoint(contexts[EndpointPath]);
        return new Extraction("fsusblog.content-field-roslyn-extraction.v1", article, comment, endpoint);
    }

    private static ImmutableArray<MetadataReference> TrustedPlatformReferences()
    {
        string? trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrWhiteSpace(trusted))
        {
            throw new InvalidOperationException("trusted platform assemblies are unavailable");
        }
        return trusted.Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToImmutableArray<MetadataReference>();
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

        Dictionary<string, ParameterContract> parameters = input.ParameterList?.Parameters.ToDictionary(
            parameter => parameter.Identifier.ValueText,
            parameter => new ParameterContract(
                Canonical(parameter.Type ?? throw new InvalidOperationException("article input parameter type is missing")),
                parameter.Type is NullableTypeSyntax))
            ?? throw new InvalidOperationException("ArticlePublicationValidationInput primary parameters are missing");
        Dictionary<string, ConstantContract> constants = DirectIntegerConstants(owner, context.Model, [
            "MaxTitleLength", "MaxSummaryLength", "MaxContentLength"
        ]);

        var fields = new[]
        {
            ArticleField(context.Model, method, parameters, constants, "article.body", "Content", "body"),
            ArticleField(context.Model, method, parameters, constants, "article.summary", "Summary", "summary"),
            ArticleField(context.Model, method, parameters, constants, "article.title", "Title", "title")
        };
        return new ArticleExtraction(ownerSymbol.ToDisplayString(), MethodSignature(methodSymbol), fields);
    }

    private static ArticleFieldContract ArticleField(
        SemanticModel model,
        MethodDeclarationSyntax method,
        IReadOnlyDictionary<string, ParameterContract> parameters,
        IReadOnlyDictionary<string, ConstantContract> constants,
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
        string constantName = (maximumCondition.Right as IdentifierNameSyntax)?.Identifier.ValueText
            ?? throw new InvalidOperationException($"{localName} maximum validation constant is unsupported");
        Require(constants.ContainsKey(constantName), $"{localName} maximum constant {constantName} is not owned by ArticlePublicationValidator");
        string emptyAction = emptyBranch.Statement.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Select(InvocationName).FirstOrDefault(name => name is "AddError" or "AddWarning") ?? "none";
        return new ArticleFieldContract(
            id,
            inputMember,
            parameters[inputMember],
            Canonical(initializer),
            Normalization(initializer),
            LocalDataflow(method, declarator, local, model),
            new BranchContract(
                Canonical(emptyBranch.Condition),
                emptyAction,
                Canonical(maximumBranch.Condition),
                maximumCondition.OperatorToken.ValueText,
                "if-else-if"),
            new NamedConstantContract(constantName, constants[constantName]));
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
        Dictionary<string, ConstantContract> constants = DirectIntegerConstants(limits, context.Model, constantNames);
        var methods = new[]
        {
            DirectMethodContract(limits, context.Model, limitsSymbol, "NormalizeMaxChars", ["int?"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "NormalizeMaxUtf8Bytes", ["int?"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "ValidateMaxChars", ["int"]),
            DirectMethodContract(limits, context.Model, limitsSymbol, "ValidateMaxUtf8Bytes", ["int"])
        };
        var attributes = content.AttributeLists.SelectMany(list => list.Attributes).Select(attribute =>
        {
            string name = attribute.Name.ToString().Split('.').Last();
            SeparatedSyntaxList<AttributeArgumentSyntax> arguments = attribute.ArgumentList?.Arguments ?? default;
            return new AttributeContract(
                name,
                arguments.Count == 0 ? null : string.Join(" , ", arguments.Select(Canonical)),
                arguments.Count == 0 ? null : Canonical(arguments[0].Expression));
        }).ToArray();
        var property = new PropertyContract(
            Canonical(content),
            Canonical(content.Type),
            content.Type is NullableTypeSyntax,
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
        ExpressionSyntax predicateExpression = predicateDeclaration.ExpressionBody?.Expression
            ?? throw new InvalidOperationException("comment predicate must remain expression-bodied");
        BinaryExpressionSyntax characterClause = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Single(expression => ReferencesNamedLength(expression.Left, "content"));
        BinaryExpressionSyntax utf8Clause = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Single(expression => expression.Left is InvocationExpressionSyntax invocation
                && Canonical(invocation.Expression) == "Encoding . UTF8 . GetByteCount");
        string[] connectors = predicateExpression.DescendantNodesAndSelf().OfType<BinaryExpressionSyntax>()
            .Where(expression => expression.IsKind(SyntaxKind.LogicalAndExpression) || expression.IsKind(SyntaxKind.LogicalOrExpression))
            .OrderBy(expression => expression.OperatorToken.SpanStart)
            .Select(expression => expression.OperatorToken.ValueText)
            .ToArray();
        bool nonWhitespace = predicateExpression.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Any(invocation => InvocationName(invocation) == "IsNullOrWhiteSpace"
                && invocation.ArgumentList.Arguments.Any(argument => Canonical(argument.Expression) == "content"));
        var predicate = new PredicateContract(
            Canonical(predicateExpression),
            connectors,
            nonWhitespace,
            characterClause.OperatorToken.ValueText,
            Canonical(characterClause.Right),
            utf8Clause.OperatorToken.ValueText,
            Canonical(utf8Clause.Right));

        VariableDeclaratorSyntax[] contentDeclarations = owner.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Where(declaration => declaration.Identifier.ValueText == "content"
                && declaration.Initializer?.Value.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>()
                    .Any(access => Canonical(access) == "request . Content") == true)
            .ToArray();
        Require(contentDeclarations.Length > 0, "comment endpoint content initializer is missing");
        var flows = contentDeclarations.Select(declaration =>
        {
            ILocalSymbol local = RequireSymbol(context.Model.GetDeclaredSymbol(declaration) as ILocalSymbol, "endpoint content");
            SyntaxNode flowScope = declaration.Ancestors().FirstOrDefault(node => node is AnonymousFunctionExpressionSyntax or MethodDeclarationSyntax)
                ?? throw new InvalidOperationException("comment endpoint content flow scope is missing");
            ExpressionSyntax initializer = declaration!.Initializer?.Value
                ?? throw new InvalidOperationException("comment endpoint content initializer is missing");
            return new EndpointFlowContract(
                Canonical(initializer),
                Normalization(initializer),
                LocalDataflow(flowScope, declaration, local, context.Model));
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
        return new MethodContract(MethodSignature(symbol), Canonical(declaration.Body ?? (SyntaxNode?)declaration.ExpressionBody?.Expression
            ?? throw new InvalidOperationException($"{name} body is missing")));
    }

    private static MethodDeclarationSyntax DirectMethod(
        TypeDeclarationSyntax owner,
        SemanticModel model,
        string name,
        string[] parameterTypes)
    {
        MethodDeclarationSyntax[] matches = owner.Members.OfType<MethodDeclarationSyntax>()
            .Where(method => method.Identifier.ValueText == name
                && method.ParameterList.Parameters.Select(parameter => CanonicalType(parameter.Type
                    ?? throw new InvalidOperationException($"{name} parameter type is missing"))).SequenceEqual(parameterTypes))
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
            result[name] = new ConstantContract(Canonical(initializer), (int)value.Value!);
        }
        return result;
    }

    private static string[] LocalDataflow(
        SyntaxNode scope,
        VariableDeclaratorSyntax declaration,
        ILocalSymbol local,
        SemanticModel model)
    {
        var facts = new List<(int Position, string Fact)>
        {
            (declaration.SpanStart, $"declare {Canonical(declaration.Initializer?.Value
                ?? throw new InvalidOperationException($"{local.Name} initializer is missing"))}")
        };
        foreach (AssignmentExpressionSyntax assignment in scope.DescendantNodes().OfType<AssignmentExpressionSyntax>())
        {
            if (SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(assignment.Left).Symbol, local))
            {
                facts.Add((assignment.SpanStart, $"assign {Canonical(assignment)}"));
            }
        }
        foreach (StatementSyntax statement in scope.DescendantNodes().OfType<StatementSyntax>())
        {
            if (statement is BlockSyntax) continue;
            bool references = statement.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
                .Any(identifier => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(identifier).Symbol, local));
            if (references)
            {
                facts.Add((statement.SpanStart, $"statement {Canonical(statement)}"));
            }
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
            && InvocationName(invocation) == "IsNullOrWhiteSpace"
            && invocation.ArgumentList.Arguments.Any(argument => argument.Expression.DescendantNodesAndSelf()
                .OfType<IdentifierNameSyntax>()
                .Any(identifier => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(identifier).Symbol, local)));
    }

    private static bool ReferencesLocalLength(ExpressionSyntax expression, ILocalSymbol local, SemanticModel model)
        => expression is MemberAccessExpressionSyntax access
            && access.Name.Identifier.ValueText == "Length"
            && access.Expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>()
                .Any(identifier => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(identifier).Symbol, local));

    private static bool ReferencesNamedLength(ExpressionSyntax expression, string name)
        => expression is MemberAccessExpressionSyntax access
            && access.Name.Identifier.ValueText == "Length"
            && Canonical(access.Expression) == name;

    private static string Normalization(ExpressionSyntax initializer)
    {
        string[] invocations = initializer.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>()
            .Select(InvocationName).ToArray();
        if (invocations.Contains("Trim", StringComparer.Ordinal))
            return "trim";
        if (invocations.Contains("Normalize", StringComparer.Ordinal))
            return "normalize";
        return "none";
    }

    private static string InvocationName(InvocationExpressionSyntax invocation)
        => invocation.Expression switch
        {
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
            MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
            _ => Canonical(invocation.Expression)
        };

    private static string MethodSignature(IMethodSymbol symbol)
        => $"{symbol.ContainingType.ToDisplayString()}.{symbol.Name}({string.Join(",", symbol.Parameters.Select(parameter => parameter.Type.ToDisplayString()))})";

    private static T RequireSymbol<T>(T? symbol, string label) where T : class, ISymbol
        => symbol ?? throw new InvalidOperationException($"cannot resolve declared symbol for {label}");

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static string Canonical(SyntaxNode node)
        => string.Join(" ", node.DescendantTokens().Select(CanonicalToken));

    private static string CanonicalType(TypeSyntax type)
        => Canonical(type).Replace(" ", string.Empty, StringComparison.Ordinal);

    private static string CanonicalToken(SyntaxToken token)
        => token.Kind() switch
        {
            SyntaxKind.StringLiteralToken or SyntaxKind.CharacterLiteralToken or SyntaxKind.InterpolatedStringTextToken => "<literal>",
            _ => token.ValueText
        };

    private sealed record SourceContext(CompilationUnitSyntax Root, SemanticModel Model);

    internal sealed record Extraction(string Schema, ArticleExtraction Article, CommentExtraction Comment, EndpointExtraction Endpoint);
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
    internal sealed record ParameterContract(string Type, bool Nullable);
    internal sealed record BranchContract(
        string EmptyCondition,
        string EmptyAction,
        string MaximumCondition,
        string MaximumOperator,
        string ControlFlow);
    internal sealed record NamedConstantContract(string Name, ConstantContract Contract);
    internal sealed record ConstantContract(string Expression, int Value);
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
    internal sealed record AttributeContract(string Name, string? Arguments, string? FirstArgument);
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
