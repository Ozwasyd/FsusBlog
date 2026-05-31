using System.Text.RegularExpressions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class EndpointPolicyContractTests
{
    [Fact]
    public void BinaryAuthPowChallenge_RequiresNoStoreResponse()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Auth.cs"));

        Assert.Matches(
            new Regex(
                @"MapGet\(""/auth/pow-challenge""[\s\S]*?\.AllowAnonymous\(\)\s*\.RequireNoStoreResponse\(\);",
                RegexOptions.CultureInvariant),
            source);
    }

    [Fact]
    public void BinaryArticleAdminRoutes_AreUnderAdminPrefix()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Articles.cs"));

        Assert.Contains("MapGet(\"/admin/article\"", source, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/admin/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/admin/article\"", source, StringComparison.Ordinal);
        Assert.Contains("MapPut(\"/admin/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MapGet(\"/article/{id:int}\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MapPost(\"/article\"", source, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
