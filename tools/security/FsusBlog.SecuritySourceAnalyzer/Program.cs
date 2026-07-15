using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

return await SecuritySourceAnalyzerProgram.RunAsync(args);

internal static class SecuritySourceAnalyzerProgram
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    internal static Task<int> RunAsync(string[] args)
    {
        AnalyzerArguments parsed = AnalyzerArguments.Parse(args);
        string root = Path.GetFullPath(parsed.Root);
        string policyPath = ResolvePath(root, parsed.Policy);
        AnalyzerPolicy policy = JsonSerializer.Deserialize<AnalyzerPolicy>(File.ReadAllText(policyPath), JsonOptions)
            ?? throw new InvalidOperationException("security_source_policy_invalid");

        string[] sources = parsed.Sources.Count > 0
            ? parsed.Sources.Select(source => ResolvePath(root, source)).Distinct(StringComparer.Ordinal).ToArray()
            : DiscoverSources(root, policy);
        var diagnostics = new List<AnalyzerDiagnostic>();
        foreach (string sourcePath in sources)
        {
            AnalyzeSource(root, sourcePath, policy, parsed.FixtureMode, diagnostics);
        }

        var report = new AnalyzerReport(
            policy.Schema,
            diagnostics.Count == 0 ? "passed" : "failed",
            sources.Length,
            diagnostics.OrderBy(item => item.Path, StringComparer.Ordinal)
                .ThenBy(item => item.Line)
                .ThenBy(item => item.RuleId, StringComparer.Ordinal)
                .ToArray());
        Console.WriteLine(JsonSerializer.Serialize(report, JsonOptions));
        return Task.FromResult(diagnostics.Count == 0 ? 0 : 1);
    }

    private static void AnalyzeSource(
        string root,
        string sourcePath,
        AnalyzerPolicy policy,
        bool fixtureMode,
        List<AnalyzerDiagnostic> diagnostics)
    {
        string relative = Path.GetRelativePath(root, sourcePath).Replace(Path.DirectorySeparatorChar, '/');
        string source = File.ReadAllText(sourcePath);
        SyntaxTree syntaxTree = CSharpSyntaxTree.ParseText(source, path: relative);
        SyntaxNode syntaxRoot = syntaxTree.GetRoot();

        foreach (AnalyzerRule rule in policy.Rules)
        {
            if (!fixtureMode && !rule.Include.Any(pattern => GlobMatches(relative, pattern)))
            {
                continue;
            }

            switch (rule.Kind)
            {
                case "forbid-random-shared":
                    foreach (MemberAccessExpressionSyntax member in syntaxRoot.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
                    {
                        string memberText = member.ToString();
                        if (memberText is "Random.Shared" or "System.Random.Shared" ||
                            memberText.EndsWith(".Random.Shared", StringComparison.Ordinal))
                        {
                            Add(rule, relative, member, "Use ISecurityRandomSource or RandomNumberGenerator instead of Random.Shared.", diagnostics);
                        }
                    }
                    break;

                case "forbid-random-constructor":
                    foreach (ObjectCreationExpressionSyntax creation in syntaxRoot.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
                    {
                        string typeName = creation.Type.ToString();
                        if (typeName is "Random" or "System.Random" ||
                            typeName.EndsWith(".System.Random", StringComparison.Ordinal) ||
                            typeName.EndsWith("::System.Random", StringComparison.Ordinal))
                        {
                            Add(rule, relative, creation, "Security code must not construct System.Random.", diagnostics);
                        }
                    }
                    break;

                case "require-fixed-time-sensitive-comparison":
                    foreach (InvocationExpressionSyntax invocation in syntaxRoot.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        string invocationText = invocation.ToString();
                        bool ordinalIgnoreCase =
                            invocationText.Contains("StringComparison.OrdinalIgnoreCase", StringComparison.Ordinal) ||
                            invocationText.Contains("StringComparer.OrdinalIgnoreCase", StringComparison.Ordinal);
                        if (!ordinalIgnoreCase ||
                            !LooksLikeSensitiveComparison(invocation.ArgumentList.Arguments))
                        {
                            continue;
                        }

                        Add(rule, relative, invocation, "Secret/hash/root/token/proof comparisons must use a fixed-time helper.", diagnostics);
                    }
                    break;

                case "forbid-raw-sensitive-log-template":
                    foreach (InvocationExpressionSyntax invocation in syntaxRoot.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        if (!InvocationName(invocation).StartsWith("Log", StringComparison.Ordinal))
                        {
                            continue;
                        }

                        foreach (LiteralExpressionSyntax literal in invocation.ArgumentList.Arguments
                            .SelectMany(argument => argument.DescendantNodesAndSelf().OfType<LiteralExpressionSyntax>()))
                        {
                            string template = literal.Token.ValueText;
                            if (Regex.IsMatch(
                                template,
                                "\\{(?:Token|Secret|Proof|AccountId|Ip|Salt|PrivateKey|Sql)\\}",
                                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
                            {
                                Add(rule, relative, literal, "Structured logs must use hashed/redacted field names for sensitive values.", diagnostics);
                            }
                        }
                    }
                    break;

                case "forbid-raw-exception-output":
                    foreach (InvocationExpressionSyntax invocation in syntaxRoot.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        if (InvocationName(invocation).StartsWith("Log", StringComparison.Ordinal))
                        {
                            continue;
                        }

                        bool leaksException = invocation.ArgumentList.Arguments.Any(argument =>
                            argument.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>().Any(member =>
                                IsExceptionDetail(member)));
                        if (leaksException)
                        {
                            Add(rule, relative, invocation, "Client/startup/health output must not include raw exception messages or runtime types.", diagnostics);
                        }
                    }
                    break;

                case "forbid-literal-data-reader-ordinal":
                    foreach (InvocationExpressionSyntax invocation in syntaxRoot.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        string methodName = InvocationName(invocation);
                        if (!DataReaderOrdinalMethods.Contains(methodName)
                            || invocation.ArgumentList.Arguments.Count == 0
                            || invocation.ArgumentList.Arguments[0].Expression is not LiteralExpressionSyntax literal
                            || !literal.IsKind(SyntaxKind.NumericLiteralExpression))
                        {
                            continue;
                        }

                        Add(
                            rule,
                            relative,
                            invocation.ArgumentList.Arguments[0],
                            "Use a named projection reader column instead of a literal data-reader ordinal.",
                            diagnostics);
                    }
                    break;

                case "minimum-constant":
                    CheckMinimumConstant(rule, relative, syntaxRoot, diagnostics);
                    break;

                default:
                    throw new InvalidOperationException($"security_source_rule_kind_unknown:{rule.Kind}");
            }
        }
    }

    private static void CheckMinimumConstant(
        AnalyzerRule rule,
        string relative,
        SyntaxNode syntaxRoot,
        List<AnalyzerDiagnostic> diagnostics)
    {
        if (string.IsNullOrWhiteSpace(rule.ConstantName) || !rule.Minimum.HasValue)
        {
            throw new InvalidOperationException($"security_source_minimum_rule_invalid:{rule.Id}");
        }

        VariableDeclaratorSyntax? variable = syntaxRoot.DescendantNodes()
            .OfType<FieldDeclarationSyntax>()
            .Where(field => field.Modifiers.Any(SyntaxKind.ConstKeyword))
            .SelectMany(field => field.Declaration.Variables)
            .FirstOrDefault(candidate => string.Equals(candidate.Identifier.ValueText, rule.ConstantName, StringComparison.Ordinal));
        if (variable?.Initializer?.Value is null)
        {
            Add(rule, relative, syntaxRoot, $"{rule.ConstantName} must exist and be initialized.", diagnostics);
            return;
        }

        string numeric = variable.Initializer.Value.ToString().Replace("_", string.Empty, StringComparison.Ordinal);
        if (!long.TryParse(numeric, out long value) || value < rule.Minimum.Value)
        {
            Add(rule, relative, variable, $"{rule.ConstantName} must be at least {rule.Minimum.Value}.", diagnostics);
        }
    }

    private static bool LooksLikeSensitiveComparison(SeparatedSyntaxList<ArgumentSyntax> arguments)
    {
        string comparison = string.Join(" ", arguments.Take(2).Select(argument => argument.Expression.ToString())).ToLowerInvariant();
        return new[] { "hash", "root", "secret", "token", "signature", "proof", "witness", "key" }
            .Any(keyword => comparison.Contains(keyword, StringComparison.Ordinal));
    }

    private static readonly IReadOnlySet<string> DataReaderOrdinalMethods = new HashSet<string>(StringComparer.Ordinal)
    {
        "GetBoolean",
        "GetByte",
        "GetChar",
        "GetDateTime",
        "GetDecimal",
        "GetDouble",
        "GetFieldValue",
        "GetFloat",
        "GetGuid",
        "GetInt16",
        "GetInt32",
        "GetInt64",
        "GetString",
        "GetValue",
        "IsDBNull"
    };

    private static bool IsExceptionDetail(MemberAccessExpressionSyntax member)
    {
        string text = member.ToString();
        if (text.EndsWith(".GetType().Name", StringComparison.Ordinal))
        {
            return true;
        }

        if (!text.EndsWith(".Message", StringComparison.Ordinal))
        {
            return false;
        }

        string receiver = member.Expression.ToString();
        return receiver is "ex" or "exception" || receiver.EndsWith("Exception", StringComparison.OrdinalIgnoreCase);
    }

    private static string InvocationName(InvocationExpressionSyntax invocation)
        => invocation.Expression switch
        {
            MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            _ => invocation.Expression.ToString()
        };

    private static void Add(
        AnalyzerRule rule,
        string relative,
        SyntaxNode node,
        string message,
        List<AnalyzerDiagnostic> diagnostics)
    {
        FileLinePositionSpan span = node.GetLocation().GetLineSpan();
        diagnostics.Add(new AnalyzerDiagnostic(
            rule.Id,
            relative,
            span.StartLinePosition.Line + 1,
            span.StartLinePosition.Character + 1,
            message));
    }

    private static string[] DiscoverSources(string root, AnalyzerPolicy policy)
    {
        string[] patterns = policy.Rules.SelectMany(rule => rule.Include).Distinct(StringComparer.Ordinal).ToArray();
        return Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(path =>
            {
                string relative = Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/');
                return patterns.Any(pattern => GlobMatches(relative, pattern));
            })
            .Order(StringComparer.Ordinal)
            .ToArray();
    }

    private static bool GlobMatches(string relative, string pattern)
    {
        string escaped = Regex.Escape(pattern.Replace('\\', '/'))
            .Replace("\\*\\*/", "(?:.*/)?", StringComparison.Ordinal)
            .Replace("\\*\\*", ".*", StringComparison.Ordinal)
            .Replace("\\*", "[^/]*", StringComparison.Ordinal)
            .Replace("\\?", "[^/]", StringComparison.Ordinal);
        return Regex.IsMatch(relative, $"^{escaped}$", RegexOptions.CultureInvariant);
    }

    private static string ResolvePath(string root, string value)
        => Path.IsPathRooted(value) ? Path.GetFullPath(value) : Path.GetFullPath(Path.Combine(root, value));
}

internal sealed record AnalyzerPolicy(string Schema, AnalyzerRule[] Rules);

internal sealed record AnalyzerRule(
    string Id,
    string Kind,
    string[] Include,
    string? ConstantName = null,
    long? Minimum = null);

internal sealed record AnalyzerDiagnostic(string RuleId, string Path, int Line, int Column, string Message);

internal sealed record AnalyzerReport(string Schema, string Status, int SourceCount, AnalyzerDiagnostic[] Diagnostics);

internal sealed record AnalyzerArguments(string Root, string Policy, bool FixtureMode, IReadOnlyList<string> Sources)
{
    internal static AnalyzerArguments Parse(string[] args)
    {
        string root = Directory.GetCurrentDirectory();
        string policy = "security/backend-source-policy.json";
        bool fixtureMode = false;
        var sources = new List<string>();
        for (int index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--root":
                    root = RequireValue(args, ref index, "--root");
                    break;
                case "--policy":
                    policy = RequireValue(args, ref index, "--policy");
                    break;
                case "--source":
                    sources.Add(RequireValue(args, ref index, "--source"));
                    break;
                case "--fixture":
                    fixtureMode = true;
                    break;
                default:
                    throw new ArgumentException($"security_source_argument_unknown:{args[index]}");
            }
        }

        return new AnalyzerArguments(root, policy, fixtureMode, sources);
    }

    private static string RequireValue(string[] args, ref int index, string name)
    {
        if (++index >= args.Length || string.IsNullOrWhiteSpace(args[index]))
        {
            throw new ArgumentException($"security_source_argument_missing:{name}");
        }

        return args[index];
    }
}
