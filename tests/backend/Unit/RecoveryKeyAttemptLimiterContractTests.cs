using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RecoveryKeyAttemptLimiterContractTests
{
    [Fact]
    public void RecoveryKeyService_RecordVerificationFailureUsesAtomicAttemptIncrement()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string method = ExtractMethodBlock(source, "private async Task<Result<RecoveryKeyVerifyResponseCoreModel>> RecordVerificationFailureAsync");

        Assert.Contains("IncrementWithExpiryAsync", method, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.SecurityRecoveryKeyAttempt", method, StringComparison.Ordinal);
        Assert.Contains("FailureWindow", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetStringAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SetStringAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyService_RateLimitCheckPrecedesCredentialLookup()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string method = ExtractMethodBlock(source, "public async Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync");

        int rateLimited = method.IndexOf("RECOVERY_KEY_RATE_LIMITED", StringComparison.Ordinal);
        int credentialLookup = method.IndexOf("LoadRecoveryKeyCredentialForUpdateAsync", StringComparison.Ordinal);

        Assert.True(rateLimited >= 0, "Recovery key verify must return the generic rate-limit error.");
        Assert.True(credentialLookup > rateLimited, "Rate limiting must happen before credential lookup to avoid state disclosure.");
    }

    [Fact]
    public void RecoveryKeyService_FailurePathsEscalateToRateLimitedAtThreshold()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string helper = ExtractMethodBlock(source, "private async Task<Result<RecoveryKeyVerifyResponseCoreModel>> RecordVerificationFailureAsync");

        Assert.Contains(">= MaxFailedAttempts", helper, StringComparison.Ordinal);
        Assert.Contains("RECOVERY_KEY_RATE_LIMITED", helper, StringComparison.Ordinal);
        Assert.Contains("RECOVERY_KEY_INVALID", helper, StringComparison.Ordinal);
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
