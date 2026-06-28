using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CryptoRandomnessHardeningContractTests
{
    [Fact]
    public void AnonymousCredentialIssuer_DoesNotFallbackToLocalIssuerKey()
    {
        string source = ReadSource("src/backend/Services/Security/AnonymousCredentialIssuerService.cs");
        string rootService = ReadSource("src/backend/Services/Security/AnonymousCredentialRootService.cs");
        string rootLifecycle = ReadSource("src/backend/Services/Security/AnonymousCredentialRootLifecycleService.cs");
        string method = ExtractBetween(source, "private static string NormalizeIssuerPublicKeyId", "}");

        Assert.DoesNotContain("issuer-key:local", source, StringComparison.Ordinal);
        Assert.DoesNotContain("issuer-key:local", rootService, StringComparison.Ordinal);
        Assert.DoesNotContain("issuer-key:local", rootLifecycle, StringComparison.Ordinal);
        Assert.Contains("throw new InvalidOperationException", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SecretAndWitnessComparisons_UseFixedTimeEquals()
    {
        string accumulator = ReadSource("src/backend/Services/Security/AnonymousCredentialRevocationAccumulator.cs");
        string admin = ReadSource("src/backend/Services/Security/AdminPrincipalService.cs");
        string totp = ReadSource("src/backend/Services/Security/TotpService.cs");

        Assert.Contains("FixedHexEquals", accumulator, StringComparison.Ordinal);
        Assert.DoesNotContain("StringComparison.OrdinalIgnoreCase) &&\n            string.Equals(expected.Value.NextRevocationHandleHash", accumulator, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Equals(computed, root, StringComparison.OrdinalIgnoreCase)", accumulator, StringComparison.Ordinal);
        Assert.Contains("FixedTimeEquals(ChallengeToken, challengeToken)", admin, StringComparison.Ordinal);
        Assert.Contains("FixedTimeEquals(ComputeTotp(secret, candidateStep), sanitizedCode)", totp, StringComparison.Ordinal);
    }

    [Fact]
    public void CryptoKeysAndIds_RejectDefaultsAndUseCryptographicRandomness()
    {
        string captcha = ReadSource("src/backend/Services/Security/CaptchaV1ChallengeProvider.cs");
        string adminPolicy = ReadSource("src/backend/Services/Security/SecurityAdminPolicyService.cs");

        Assert.Contains("KnownDevelopmentSigningKeys", captcha, StringComparison.Ordinal);
        Assert.Contains("throw new InvalidOperationException", ExtractBetween(captcha, "private static byte[] ResolveSigningKey", "private static string HashPayload"), StringComparison.Ordinal);
        Assert.Contains("RandomNumberGenerator", adminPolicy, StringComparison.Ordinal);
        Assert.DoesNotContain("Random.Shared", adminPolicy, StringComparison.Ordinal);
    }

    [Fact]
    public void CryptoParameters_MeetCurrentMinimums()
    {
        string pospace = ReadSource("src/backend/Services/Security/Argon2idPoSpaceV1ChallengeProvider.cs");
        string recovery = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string zk = ReadSource("src/backend/Services/Security/ProductionZkProofVerifier.cs");

        Assert.Contains("private const int MinMemoryKib = 19_456", pospace, StringComparison.Ordinal);
        Assert.Contains("private const int MinIterations = 2", pospace, StringComparison.Ordinal);
        Assert.Contains("private const int RecoveryKeyPbkdf2Iterations = 600_000", recovery, StringComparison.Ordinal);
        Assert.Contains("IsHexHash(request.NullifierHash, minLength: 64", zk, StringComparison.Ordinal);
        Assert.Contains("IsHexHash(request.CredentialCommitment, minLength: 64", zk, StringComparison.Ordinal);
        Assert.Contains("IsHexHash(request.IssuerPublicKeyHash, minLength: 64", zk, StringComparison.Ordinal);
        Assert.Contains("IsHexHash(request.CredentialRoot, minLength: 64", zk, StringComparison.Ordinal);
        Assert.Contains("IsHexHash(request.RevocationRoot, minLength: 64", zk, StringComparison.Ordinal);
    }

    [Fact]
    public void SealedTokensAndPayloadHashes_AvoidAmbiguousCrypto()
    {
        string sealedToken = ReadSource("src/backend/Services/Security/PerceptionSealedTokenService.cs");
        string captcha = ReadSource("src/backend/Services/Security/CaptchaV1ChallengeProvider.cs");
        string signer = ReadSource("src/backend/Services/Security/ManagedCircuitNativeCredentialSigner.cs");

        string seal = ExtractBetween(sealedToken, "public string Seal", "public PerceptionSealedTokenOpenResult Open");
        Assert.Equal(1, CountOccurrences(seal, "EncryptPayload("));
        Assert.Contains("WriteLengthPrefixed", captcha, StringComparison.Ordinal);
        Assert.Contains("HMACSHA256", signer, StringComparison.Ordinal);
        Assert.Contains("DeriveDeterministicNonce", signer, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
