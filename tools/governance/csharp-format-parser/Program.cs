using System.Text.Json;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

// Parse only: no source compilation, references, analyzers or candidate code execution.
string source = Console.In.ReadToEnd();
CompilationUnitSyntax root = CSharpSyntaxTree.ParseText(source,
    new CSharpParseOptions(LanguageVersion.CSharp14)).GetCompilationUnitRoot();
if (root.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
{
    throw new InvalidOperationException("C# format classification requires syntactically valid C# 14");
}

bool IsWhitespace(SyntaxTrivia trivia) => trivia.IsKind(SyntaxKind.WhitespaceTrivia)
    || trivia.IsKind(SyntaxKind.EndOfLineTrivia);

object[] Trivia(IEnumerable<SyntaxTrivia> trivia) => trivia.Where(item => !IsWhitespace(item))
    .Select(item => (object)new { kind = item.RawKind, text = item.ToFullString() }).ToArray();

object Token(SyntaxToken token, bool omitLeading = false) => new
{
    kind = token.RawKind,
    text = token.Text,
    leading = omitLeading ? [] : Trivia(token.LeadingTrivia),
    trailing = Trivia(token.TrailingTrivia)
};

// Only uncommented ordinary compilation-unit imports may commute. Global,
// static, alias, extern and conditional imports keep their ordered token stream.
bool ordinary = root.Usings.Count > 0 && root.Externs.Count == 0 && !root.ContainsDirectives
    && root.Usings.All(item => item.Alias is null
        && item.StaticKeyword.IsKind(SyntaxKind.None)
        && item.GlobalKeyword.IsKind(SyntaxKind.None)
        && item.Name is NameSyntax
        && item.DescendantTrivia().Where(trivia => trivia.SpanStart >= root.Usings[0].SpanStart)
            .All(IsWhitespace));
object fingerprint;
object? imports = null;
if (ordinary)
{
    UsingDirectiveSyntax first = root.Usings[0];
    UsingDirectiveSyntax last = root.Usings[^1];
    imports = new
    {
        start = first.SpanStart,
        end = last.Span.End,
        names = root.Usings.Select(item => string.Concat(item.Name!.DescendantTokens()
            .Select(token => token.Text))).ToArray()
    };
    fingerprint = new
    {
        header = Trivia(first.GetLeadingTrivia()),
        // Sorting serialized token lists retains spelling and duplicate multiplicity.
        imports = root.Usings.Select(item => JsonSerializer.Serialize(item.DescendantTokens()
            .Select(token => Token(token, token == first.GetFirstToken()))))
            .Order(StringComparer.Ordinal).ToArray(),
        body = root.DescendantTokens().Where(token => token.SpanStart >= last.Span.End)
            .Select(token => Token(token)).ToArray()
    };
}
else
{
    fingerprint = new
    {
        tokens = root.DescendantTokens().Select(token => Token(token)).ToArray()
    };
}
Console.Write(JsonSerializer.Serialize(new { fingerprint, imports }));
