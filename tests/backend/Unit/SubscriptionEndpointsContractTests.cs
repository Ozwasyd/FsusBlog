namespace FsusBlog.Server.Tests.Unit;

public sealed class SubscriptionEndpointsContractTests
{
    [Fact]
    public void SubscribeAsync_UsesSinglePostgresUpsert()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Modules", "Endpoints", "SubscriptionEndpoints.cs"));
        string method = ExtractMethodBlock(source, "public static async Task<SiteSubscriptionBinaryResponse?> SubscribeAsync");

        Assert.Contains("ON CONFLICT (email_hash) DO UPDATE", method, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Queryable<SiteSubscription>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable(new SiteSubscription", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable(existing)", method, StringComparison.Ordinal);
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

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
