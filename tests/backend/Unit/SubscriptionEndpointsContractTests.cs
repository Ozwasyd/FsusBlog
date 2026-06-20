using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SubscriptionEndpointsContractTests
{
    [Fact]
    public void SubscribeAsync_UsesSinglePostgresUpsert()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Modules", "Endpoints", "SubscriptionEndpoints.cs"));
        string method = ExtractMethodBlock(source, "public static async Task<SiteSubscriptionBinaryResponse?> SubscribeAsync");

        Assert.Contains("ON CONFLICT (email_hash) DO UPDATE", method, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Queryable<SiteSubscription>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable(new SiteSubscription", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable(existing)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UnsubscribeAsync_RequiresConsumedOwnershipProof()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Modules", "Endpoints", "SubscriptionEndpoints.cs"));
        string method = ExtractMethodBlock(source, "public static async Task<SiteSubscriptionBinaryResponse?> UnsubscribeAsync");

        Assert.DoesNotContain(
            "public static async Task<SiteSubscriptionBinaryResponse?> UnsubscribeAsync(\n        SiteSubscriptionBinaryRequest request,\n        ISqlSugarClient db,\n        CancellationToken cancellationToken)",
            source,
            StringComparison.Ordinal);
        Assert.Contains("SiteSubscriptionUnsubscribeProofClaims proof", method, StringComparison.Ordinal);
        Assert.Contains("it.EmailHash == proof.EmailHash", method, StringComparison.Ordinal);
        Assert.Contains("it.Channel == proof.Channel", method, StringComparison.Ordinal);
    }

    [Fact]
    public void BinarySubscriptionUnsubscribe_ConsumesProofBeforeDatabaseMutation()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Modules", "Endpoints", "Binary", "BinaryEndpoints.Subscriptions.cs"));

        Assert.Contains("ISiteSubscriptionProofService", source, StringComparison.Ordinal);
        Assert.Contains("SiteSubscriptionProofService.HeaderName", source, StringComparison.Ordinal);
        Assert.Contains("ConsumeUnsubscribeProofAsync", source, StringComparison.Ordinal);
        Assert.Contains("StatusCodes.Status428PreconditionRequired", source, StringComparison.Ordinal);
        Assert.True(
            source.IndexOf("ConsumeUnsubscribeProofAsync", StringComparison.Ordinal) <
            source.IndexOf("SubscriptionEndpoints.UnsubscribeAsync", StringComparison.Ordinal),
            "unsubscribe proof must be consumed before DB mutation is invoked");
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
