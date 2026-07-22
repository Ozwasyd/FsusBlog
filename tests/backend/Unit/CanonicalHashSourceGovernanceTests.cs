using System.Text.Json.Nodes;
using System.Xml.Linq;

using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SourceAnalysis")]
public sealed class CanonicalHashSourceGovernanceTests
{
    public static TheoryData<string> CanonicalSources
        => new()
        {
            "src/core/Integrity/ArticleCanonicalHashV1.cs",
            "src/core/Integrity/ArticleRightsCanonicalHashV1.cs"
        };

    [Theory]
    [MemberData(nameof(CanonicalSources))]
    public void CanonicalImplementation_StaysInsideCoreWithoutRuntimeOrExternalDependencies(string sourcePath)
    {
        CompilationUnitSyntax root = Parse(sourcePath);
        string[] forbiddenNamespaces =
        [
            "FsusBlog.Server",
            "Microsoft.AspNetCore",
            "SqlSugar",
            "StackExchange.Redis",
            "System.Net.Http",
            "System.Reflection"
        ];

        foreach (UsingDirectiveSyntax directive in root.Usings)
        {
            string importedNamespace = directive.Name?.ToString() ?? string.Empty;
            Assert.DoesNotContain(
                forbiddenNamespaces,
                forbidden => importedNamespace.StartsWith(forbidden, StringComparison.Ordinal));
        }

        Assert.DoesNotContain(
            root.DescendantTokens().Where(static token => token.IsKind(SyntaxKind.IdentifierToken)),
            static token => StringComparer.Ordinal.Equals(token.ValueText, "dynamic"));
    }

    [Fact]
    public void CoreProject_DoesNotReferenceServerOrExternalAnchoringPackages()
    {
        XDocument project = XDocument.Load(BackendTestPaths.FromRoot("src", "core", "FsusBlog.Core.csproj"));
        string[] references = project
            .Descendants()
            .Where(static element => element.Name.LocalName is "ProjectReference" or "PackageReference")
            .Select(static element => element.Attribute("Include")?.Value ?? string.Empty)
            .ToArray();

        foreach (string forbidden in new[] { "src/backend", "FsusBlog.Server", "SqlSugar", "Nethereum", "IPFS", "Arweave" })
        {
            Assert.DoesNotContain(references, reference => reference.Contains(forbidden, StringComparison.OrdinalIgnoreCase));
        }
    }

    [Fact]
    public void RightsCanonicalWriter_UsesTheGovernedBufferWriterBoundary()
    {
        CompilationUnitSyntax root = Parse("src/core/Integrity/ArticleRightsCanonicalHashV1.cs");
        string[] identifiers = root.DescendantTokens()
            .Where(static token => token.IsKind(SyntaxKind.IdentifierToken))
            .Select(static token => token.ValueText)
            .ToArray();

        Assert.Contains("IBufferWriter", identifiers);
        Assert.Contains("ArrayBufferWriter", identifiers);
        Assert.DoesNotContain("JsonSerializer", identifiers);
    }

    [Fact]
    public void OwnershipCatalog_MapsEveryCanonicalContractToCurrentOwnersAndGoldenVector()
    {
        JsonObject ownership = BackendTestPaths.ReadJsonFromRoot(
            "tests",
            "backend",
            "Fixtures",
            "canonical-hash-test-ownership.json");
        JsonObject golden = BackendTestPaths.ReadJsonFromRoot(
            "tests",
            "backend",
            "Fixtures",
            "canonical-hash-golden-vectors.json");
        string currentOwners = string.Join(
            '\n',
            BackendTestPaths.ReadAllTextFromRoot("tests", "backend", "Unit", "ArticleCanonicalHashTests.cs"),
            BackendTestPaths.ReadAllTextFromRoot("tests", "backend", "Unit", "ArticleRightsCanonicalHashTests.cs"),
            BackendTestPaths.ReadAllTextFromRoot("tests", "backend", "Unit", "IntegrityVerificationManifestServiceTests.cs"),
            BackendTestPaths.ReadAllTextFromRoot("tests", "backend", "Unit", "CanonicalHashSourceGovernanceTests.cs"));
        JsonObject[] contracts = ownership["contracts"]!.AsArray()
            .Select(static node => node!.AsObject())
            .ToArray();
        JsonObject[] vectors = golden["vectors"]!.AsArray()
            .Select(static node => node!.AsObject())
            .ToArray();

        Assert.Equal("fsusblog.canonical-hash-test-ownership.v1", ownership["schema"]!.GetValue<string>());
        Assert.Equal("fsusblog.canonical-hash-golden-vectors.v1", golden["schema"]!.GetValue<string>());
        Assert.Equal(new[] { "article-content-v1", "article-rights-v1" }, contracts.Select(static contract => contract["id"]!.GetValue<string>()));
        Assert.Equal(contracts.Length, vectors.Length);

        foreach (JsonObject contract in contracts)
        {
            string contractId = contract["id"]!.GetValue<string>();
            Assert.Contains(vectors, vector => StringComparer.Ordinal.Equals(
                contractId.Replace("-v1", string.Empty, StringComparison.Ordinal),
                vector["contract"]!.GetValue<string>()));

            IEnumerable<string> owners = new[] { contract["goldenOwner"]!.GetValue<string>() }
                .Concat(contract["behaviorOwners"]!.AsArray().Select(static node => node!.GetValue<string>()))
                .Concat(contract["manifestOwners"]!.AsArray().Select(static node => node!.GetValue<string>()));
            foreach (string owner in owners)
            {
                Assert.Contains(owner[(owner.LastIndexOf('.') + 1)..], currentOwners, StringComparison.Ordinal);
            }
        }

        Assert.Contains(ownership["governanceOwner"]!.GetValue<string>(), currentOwners, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("tests/backend/Unit/ArticleCanonicalHashTests.cs")]
    [InlineData("tests/backend/Unit/ArticleRightsCanonicalHashTests.cs")]
    public void ProductBehaviorTests_DoNotOwnRuntimeShapeOrPayloadFragmentAssertions(string sourcePath)
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(sourcePath.Split('/'));

        Assert.DoesNotContain("RuntimeMetadataInspection", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetReferencedAssemblies", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Assert.Contains(\"\\n", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Assert.StartsWith(\"fsusblog.", source, StringComparison.Ordinal);
    }

    private static CompilationUnitSyntax Parse(string sourcePath)
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(sourcePath.Split('/'));
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, path: sourcePath);
        Diagnostic[] errors = tree.GetDiagnostics()
            .Where(static diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();

        Assert.True(errors.Length == 0, $"{sourcePath} has syntax errors: {string.Join("; ", errors.Select(static error => error.ToString()))}");
        return tree.GetCompilationUnitRoot();
    }
}
