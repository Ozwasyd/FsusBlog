using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace FsusBlog.Tools.MemorySyntaxObserver;

internal sealed record SemanticSiteInput(string Id, string Path, int Line, string Pattern);
internal sealed record SemanticProjectInput(string BaseDirectory, string[] Arguments, SemanticSiteInput[] Sites);

// SOURCE EVIDENCE: Bind using the owning project's actual SDK compiler arguments.
// No emit, analyzer or generator execution, allocator, product I/O or qualification
// occurs here. Unbound/generated dependencies and ownership remain explicit gaps.
internal static class MemorySemanticSourceObserver
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public static int Run()
    {
        SemanticProjectInput input = JsonSerializer.Deserialize<SemanticProjectInput>(Console.In.ReadToEnd(), s_json)
            ?? throw new InvalidDataException("semantic source input missing");
        if (!Path.IsPathFullyQualified(input.BaseDirectory) || !Directory.Exists(input.BaseDirectory))
        {
            throw new InvalidDataException("owning project base directory must exist and be absolute");
        }
        CSharpCommandLineArguments arguments = CSharpCommandLineParser.Default.Parse(
            input.Arguments, input.BaseDirectory, sdkDirectory: null);
        if (arguments.Errors.Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
        {
            throw new InvalidDataException("original compiler arguments could not be parsed");
        }
        var snapshots = new Dictionary<string, string>(StringComparer.Ordinal);
        var trees = new Dictionary<string, SyntaxTree>(StringComparer.Ordinal);
        foreach (CommandLineSourceFile file in arguments.SourceFiles)
        {
            string path = Path.GetFullPath(file.Path, input.BaseDirectory);
            byte[] bytes = Hold(path, snapshots);
            trees.Add(path, CSharpSyntaxTree.ParseText(Encoding.UTF8.GetString(bytes), arguments.ParseOptions, path));
        }
        var references = new List<MetadataReference>();
        foreach (CommandLineReference reference in arguments.MetadataReferences)
        {
            string path = Path.GetFullPath(reference.Reference, input.BaseDirectory);
            byte[] bytes = Hold(path, snapshots);
            references.Add(MetadataReference.CreateFromImage(bytes, reference.Properties, filePath: path));
        }
        if (references.Count == 0 || trees.Count == 0)
        {
            throw new InvalidDataException("original project source and resolved reference closure required");
        }
        var compilation = CSharpCompilation.Create("MemorySourceObservation", trees.Values,
            references, arguments.CompilationOptions);
        Diagnostic[] errors = compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToArray();
        var observations = new List<object>();
        foreach (SemanticSiteInput site in input.Sites)
        {
            string path = Path.GetFullPath(site.Path, input.BaseDirectory);
            if (!trees.TryGetValue(path, out SyntaxTree? tree))
            {
                observations.Add(new
                {
                    id = site.Id,
                    status = "OutsideOwningCompilation",
                    ownership = "NotVerified"
                });
                continue;
            }
            var text = tree.GetText();
            if (site.Line <= 0 || site.Line > text.Lines.Count)
            {
                throw new InvalidDataException("semantic site line outside original source");
            }
            var line = text.Lines[site.Line - 1];
            MatchCollection matches = Regex.Matches(line.ToString(), site.Pattern, RegexOptions.CultureInvariant);
            if (matches.Count == 0)
            {
                throw new InvalidDataException("semantic site differs from original source");
            }
            SemanticModel model = compilation.GetSemanticModel(tree);
            SyntaxNode root = tree.GetRoot();
            var bindings = new List<object>();
            foreach (Match match in matches)
            {
                int position = line.Start + match.Index;
                SyntaxTrivia trivia = root.FindTrivia(position, findInsideTrivia: true);
                SyntaxToken token = root.FindToken(position, findInsideTrivia: true);
                if ((trivia.FullSpan.Contains(position) && !trivia.IsKind(SyntaxKind.None)
                        && !trivia.IsKind(SyntaxKind.WhitespaceTrivia) && !trivia.IsKind(SyntaxKind.EndOfLineTrivia))
                    || token.IsKind(SyntaxKind.StringLiteralToken) || token.IsKind(SyntaxKind.Utf8StringLiteralToken)
                    || token.IsKind(SyntaxKind.InterpolatedStringTextToken))
                {
                    bindings.Add(new
                    {
                        status = "NonExecutableText",
                        ownership = "NotVerified"
                    });
                    continue;
                }
                SyntaxNode? node = token.Parent;
                SyntaxNode? expression = node?.AncestorsAndSelf().FirstOrDefault(value =>
                    value is InvocationExpressionSyntax or ArrayCreationExpressionSyntax or ObjectCreationExpressionSyntax);
                SyntaxNode? bindable = expression ?? node?.AncestorsAndSelf().FirstOrDefault(value => value is TypeSyntax);
                SyntaxNode? declaration = node?.AncestorsAndSelf().FirstOrDefault(value =>
                    value is VariableDeclaratorSyntax or MethodDeclarationSyntax or ConstructorDeclarationSyntax
                        or PropertyDeclarationSyntax or BaseTypeDeclarationSyntax);
                ISymbol? symbol = bindable is not null ? model.GetSymbolInfo(bindable).Symbol
                    : declaration is not null ? model.GetDeclaredSymbol(declaration) : null;
                ITypeSymbol? type = bindable is not null ? model.GetTypeInfo(bindable).Type : null;
                ISymbol? enclosing = model.GetEnclosingSymbol(position);
                bindings.Add(new
                {
                    status = symbol is not null || (type is not null && type.TypeKind != TypeKind.Error)
                        ? "BoundSourceSymbol" : "UnboundSourceSymbol",
                    symbol = symbol?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
                    type = type?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
                    enclosing = enclosing?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
                    ownership = "NotVerified"
                });
            }
            observations.Add(new
            {
                id = site.Id,
                sourceDigest = snapshots[path],
                bindings
            });
        }
        foreach ((string path, string digest) in snapshots)
        {
            if (Digest(File.ReadAllBytes(path)) != digest)
            {
                throw new InvalidDataException("owning compilation input changed during semantic observation");
            }
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            schema = "fsusblog.memory-semantic-source-observation.v1",
            evidenceLevel = "compiler-source-symbols-only",
            acceptance = "NotVerified",
            commandArgumentsDigest = Digest(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(input.Arguments))),
            sourceCount = trees.Count,
            referenceCount = references.Count,
            compilationErrorCount = errors.Length,
            compilationErrors = errors.Select(error => new { error.Id, message = error.GetMessage(), path = error.Location.SourceTree?.FilePath }),
            generatorReplay = "NotRun; generated dependency gaps prevent complete compiler equivalence",
            snapshots,
            observations
        }, s_json));
        return 0;
    }

    private static byte[] Hold(string path, Dictionary<string, string> snapshots)
    {
        byte[] bytes = File.ReadAllBytes(path);
        snapshots[path] = Digest(bytes);
        return bytes;
    }

    private static string Digest(byte[] bytes) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
}
