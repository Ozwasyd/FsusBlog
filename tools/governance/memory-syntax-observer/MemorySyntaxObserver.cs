using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace FsusBlog.Tools.MemorySyntaxObserver;

internal sealed record SourceInput(string Path, string Source, SiteInput[] Sites);
internal sealed record SiteInput(string Id, int Line, string Pattern);
internal sealed record SyntaxFact(string Role, string Producer, string Owner, string Operation, string RequestedLength, string CapacityModel);
internal sealed record SiteObservation(string Id, string SourceDigest, SyntaxFact[] Facts);

internal static class MemorySyntaxObserver
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.SequenceEqual(new[] { "--bind-source" }))
            {
                return MemorySemanticSourceObserver.Run();
            }
            if (arguments.Length != 0)
            {
                throw new InvalidDataException("unsupported memory source observer mode");
            }
            SourceInput[] inputs = JsonSerializer.Deserialize<SourceInput[]>(Console.In.ReadToEnd(), s_json)
                ?? throw new InvalidDataException("syntax observation inputs missing");
            var observations = new List<SiteObservation>();
            var parseDiagnostics = new List<object>();
            foreach (SourceInput input in inputs)
            {
                SyntaxTree tree = CSharpSyntaxTree.ParseText(input.Source,
                    new CSharpParseOptions(LanguageVersion.CSharp14), input.Path);
                parseDiagnostics.AddRange(tree.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                    .Select(diagnostic => (object)new
                    {
                        path = input.Path,
                        id = diagnostic.Id,
                        line = diagnostic.Location.GetLineSpan().StartLinePosition.Line + 1,
                        severity = "Error",
                        evidence = "syntax-recovery-only; no semantic compilation claim"
                    }));
                SyntaxNode root = tree.GetRoot();
                SourceText text = tree.GetText();
                string sourceDigest = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(input.Source)));
                foreach (SiteInput site in input.Sites)
                {
                    TextLine line = text.Lines[site.Line - 1];
                    MatchCollection matches = Regex.Matches(line.ToString(), site.Pattern, RegexOptions.CultureInvariant);
                    if (matches.Count == 0)
                    {
                        throw new InvalidDataException("syntax site does not match its held source: " + site.Id);
                    }
                    SyntaxFact[] facts = matches.Select(match => Observe(root, line.Start + match.Index)).ToArray();
                    observations.Add(new SiteObservation(site.Id, sourceDigest, facts));
                }
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schema = "fsusblog.memory-syntax-observation.v1",
                evidenceLevel = "csharp-syntax-only",
                roslyn = typeof(CSharpSyntaxTree).Assembly.GetName().Version?.ToString(),
                observations,
                parseDiagnostics
            }, s_json));
            return 0;
        }
        catch (Exception exception) when (exception is JsonException or InvalidDataException or ArgumentException)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }
    }

    private static SyntaxFact Observe(SyntaxNode root, int position)
    {
        SyntaxTrivia trivia = root.FindTrivia(position, findInsideTrivia: true);
        SyntaxToken token = root.FindToken(position, findInsideTrivia: true);
        SyntaxNode? node = token.Parent;
        SyntaxNode[] ancestors = node?.AncestorsAndSelf().ToArray() ?? [];
        string[] types = ancestors.OfType<BaseTypeDeclarationSyntax>().Reverse()
            .Select(type => type.Identifier.ValueText).ToArray();
        string namespaceName = ancestors.OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault()?.Name.ToString() ?? "global";
        string owner = namespaceName + "." + (types.Length == 0 ? "file" : string.Join('.', types));
        SyntaxNode? member = ancestors.FirstOrDefault(value => value is MethodDeclarationSyntax
            or ConstructorDeclarationSyntax or LocalFunctionStatementSyntax or PropertyDeclarationSyntax);
        string memberName = member switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            ConstructorDeclarationSyntax constructor => constructor.Identifier.ValueText,
            LocalFunctionStatementSyntax function => function.Identifier.ValueText,
            PropertyDeclarationSyntax property => property.Identifier.ValueText,
            _ => ancestors.OfType<VariableDeclaratorSyntax>().FirstOrDefault()?.Identifier.ValueText ?? "declaration"
        };
        string producer = owner + "." + memberName;
        if (trivia.FullSpan.Contains(position) && !trivia.IsKind(SyntaxKind.None)
            && !trivia.IsKind(SyntaxKind.WhitespaceTrivia) && !trivia.IsKind(SyntaxKind.EndOfLineTrivia))
        {
            return new SyntaxFact("trivia-or-disabled-source", producer, owner, trivia.Kind().ToString(),
                "not-an-allocation", "no-capacity-inferred-from-trivia");
        }
        if (token.IsKind(SyntaxKind.StringLiteralToken) || token.IsKind(SyntaxKind.Utf8StringLiteralToken)
            || token.IsKind(SyntaxKind.InterpolatedStringTextToken))
        {
            return new SyntaxFact("literal-reference", producer, owner, token.Kind().ToString(),
                "not-an-allocation", "no-capacity-inferred-from-literal");
        }
        ArrayCreationExpressionSyntax? array = ancestors.OfType<ArrayCreationExpressionSyntax>().FirstOrDefault();
        if (array is not null)
        {
            return new SyntaxFact("array-creation", producer, owner, "new-array",
                array.Type.RankSpecifiers.ToString(), "allocated-array-Length-plus-element-size-and-runtime-object-overhead");
        }
        ObjectCreationExpressionSyntax? creation = ancestors.OfType<ObjectCreationExpressionSyntax>().FirstOrDefault();
        if (creation is not null)
        {
            return new SyntaxFact("object-creation", producer, owner, creation.Type.ToString(),
                "constructor-arguments:" + creation.ArgumentList?.ToString(), "constructor-specific-capacity; backing/growth-owner-model-required");
        }
        InvocationExpressionSyntax? invocation = ancestors.OfType<InvocationExpressionSyntax>().FirstOrDefault();
        if (invocation is not null)
        {
            string operation = invocation.Expression.ToString();
            string model = operation.EndsWith(".Rent", StringComparison.Ordinal)
                ? "requested-minimum; allocated-rented-array-Length; pool-retention-separate"
                : operation.EndsWith(".Return", StringComparison.Ordinal)
                    ? "release-call; pool-return-does-not-imply-process-reclaim"
                    : "callee-owned-model; result/backing-capacity-separate-from-requested-length";
            return new SyntaxFact("invocation", producer, owner, operation,
                "arguments:" + invocation.ArgumentList, model);
        }
        return new SyntaxFact("declaration-or-reference", producer, owner, token.ValueText,
            "not-a-proven-allocation", "retained-reference-or-type; use-owning-family-capacity-model");
    }
}
