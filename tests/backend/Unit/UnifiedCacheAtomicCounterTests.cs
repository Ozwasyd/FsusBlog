using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UnifiedCacheAtomicCounterTests
{
    [Fact]
    public void IUnifiedCache_ExposesIncrementWithExpiryPrimitive()
    {
        string source = ReadSource("src/backend/Infrastructure/Cache/IUnifiedCache.cs");

        Assert.Contains("IncrementWithExpiryAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void UnifiedCache_IncrementWithExpiryUsesSingleRedisScriptAndPreservesExistingWindow()
    {
        string source = ReadSource("src/backend/Infrastructure/Cache/IUnifiedCache.cs");
        string method = ExtractMethodBlock(source, "public async Task<long> IncrementWithExpiryAsync");

        Assert.Contains("ScriptEvaluateAsync", method, StringComparison.Ordinal);
        Assert.Contains("INCRBY", method, StringComparison.Ordinal);
        Assert.Contains("PTTL", method, StringComparison.Ordinal);
        Assert.Contains("PEXPIRE", method, StringComparison.Ordinal);
        Assert.Contains("< 0", method, StringComparison.Ordinal);
        Assert.DoesNotContain("StringIncrementAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("KeyExpireAsync", method, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

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
