using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

internal static partial class XunitAdapterProgram
{
    private static Span GetSpan(SyntaxNode node, SyntaxTree tree)
    {
        FileLinePositionSpan lineSpan = tree.GetLineSpan(node.Span);
        return new Span
        {
            Start = new Position { Line = lineSpan.StartLinePosition.Line + 1, Column = lineSpan.StartLinePosition.Character + 1 },
            End = new Position { Line = lineSpan.EndLinePosition.Line + 1, Column = lineSpan.EndLinePosition.Character + 1 }
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
        if (assemblyName is "FsusBlog.Server.Tests" or "AdapterFixtureTests" or "FsusBlog.AdapterFixture")
            return "test";
        if (assemblyName.EndsWith("Tests", StringComparison.Ordinal) || assemblyName.EndsWith("Test", StringComparison.Ordinal))
            return "test";
        if (assemblyName.StartsWith("xunit", StringComparison.OrdinalIgnoreCase))
            return "test-framework";
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
        if (seenTestMethods.ContainsKey(target))
            return true;
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
        foreach (InvocationExpressionSyntax invocation in InvocationNodes(methodDeclaration))
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
                if (IsAssertionCandidate(
                    target,
                    fact.CallsTestMethod,
                    semanticModel.Compilation,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default)))
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

        foreach (ReturnStatementSyntax returnStatement in
            methodDeclaration.Body?.DescendantNodes().OfType<ReturnStatementSyntax>() ?? [])
        {
            facts.ReturnStatements.Add(returnStatement.ToString());
        }
        if (methodDeclaration.ExpressionBody is not null)
        {
            facts.ReturnStatements.Add(methodDeclaration.ExpressionBody.Expression.ToString());
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

    private static IEnumerable<InvocationExpressionSyntax> InvocationNodes(MethodDeclarationSyntax declaration)
        => declaration.Body?.DescendantNodes().OfType<InvocationExpressionSyntax>()
            ?? declaration.ExpressionBody?.Expression
                .DescendantNodesAndSelf()
                .OfType<InvocationExpressionSyntax>()
            ?? [];

    private static bool IsAssertionCandidate(
        IMethodSymbol target,
        bool callsTestMethod,
        Compilation compilation,
        HashSet<ISymbol> visited)
    {
        if (callsTestMethod)
            return false;
        if (IsDirectAssertionCandidate(target, callsTestMethod))
            return true;
        if (AssemblyKind(target) != "test" || !visited.Add(target.OriginalDefinition))
            return false;

        foreach (SyntaxReference syntaxReference in target.DeclaringSyntaxReferences)
        {
            if (syntaxReference.GetSyntax() is not MethodDeclarationSyntax declaration)
                continue;
            SemanticModel semanticModel = compilation.GetSemanticModel(declaration.SyntaxTree);
            foreach (InvocationExpressionSyntax invocation in InvocationNodes(declaration))
            {
                SymbolInfo symbolInfo = semanticModel.GetSymbolInfo(invocation);
                IEnumerable<IMethodSymbol> candidates = symbolInfo.Symbol is IMethodSymbol symbol
                    ? [symbol]
                    : symbolInfo.CandidateSymbols.OfType<IMethodSymbol>();
                foreach (IMethodSymbol candidate in candidates)
                {
                    bool candidateCallsTest = candidate.GetAttributes().Any(attribute =>
                    {
                        string attributeName = attribute.AttributeClass?.Name ?? "";
                        return attributeName is "FactAttribute" or "TheoryAttribute";
                    });
                    if (IsDirectAssertionCandidate(candidate, candidateCallsTest)
                        || IsAssertionCandidate(candidate, candidateCallsTest, compilation, visited))
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    private static bool IsDirectAssertionCandidate(IMethodSymbol target, bool callsTestMethod)
    {
        if (callsTestMethod)
            return false;
        string name = target.Name;
        string containing = target.ContainingType?.ToDisplayString() ?? "";
        return containing == "Xunit.Assert"
            || containing == "Xunit.Record"
            || containing.StartsWith("FluentAssertions", StringComparison.Ordinal)
            || containing == "NSubstitute.Received"
            || (containing == "NSubstitute.SubstituteExtensions"
                && name is "Received" or "DidNotReceive" or "ReceivedWithAnyArgs" or "DidNotReceiveWithAnyArgs");
    }

}
