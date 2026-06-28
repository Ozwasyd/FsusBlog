using System.Runtime.CompilerServices;
using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RecoveryKeyServiceTests
{
    [Fact]
    public void RecoveryKeyService_SourceUsesIndependentPepperedHashing()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");

        Assert.Contains("RecoveryKeyPepper", source, StringComparison.Ordinal);
        Assert.Contains("Rfc2898DeriveBytes.Pbkdf2", source, StringComparison.Ordinal);
        Assert.Contains("HMACSHA256", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ITotpService", source, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaRecoveryCodesHash", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HashRecoveryCodes", source, StringComparison.Ordinal);
        Assert.DoesNotContain("TryConsumeRecoveryCode", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyEndpoints_SourceExposeBinaryAedsRecoveryFlow()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("\"/auth/recovery-key/create\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/rotate\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/verify\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/passkey/register/begin\"", source, StringComparison.Ordinal);
        Assert.Contains("\"/auth/recovery-key/passkey/register/complete\"", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyCreateResponse", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyVerifyRequest", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeyVerifyResponse", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.RecoveryKeySessionRequest", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CredentialMutationEndpoints_DelegateStepUpToUnifiedService()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        string recoveryCreate = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/create\"",
            "group.MapPost(\"/auth/recovery-key/rotate\"");
        string recoveryRotate = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/rotate\"",
            "group.MapPost(\"/auth/recovery-key/verify\"");
        string passkeyDelete = ExtractBetween(
            source,
            "group.MapDelete(\"/auth/passkey/credentials/{id:int}\"",
            "group.MapPut(\"/auth/passkey/credentials/{id:int}/name\"");
        string passkeyRename = ExtractBetween(
            source,
            "group.MapPut(\"/auth/passkey/credentials/{id:int}/name\"",
            "private static BinaryFrameResult RecoveryKeyError");

        Assert.Contains("IUserSecurityStepUpService stepUp", recoveryCreate, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", recoveryCreate, StringComparison.Ordinal);
        Assert.Contains("UserSecurityStepUpActions.RecoveryKeyCreate", recoveryCreate, StringComparison.Ordinal);
        Assert.Contains("IUserSecurityStepUpService stepUp", recoveryRotate, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", recoveryRotate, StringComparison.Ordinal);
        Assert.Contains("UserSecurityStepUpActions.RecoveryKeyRotate", recoveryRotate, StringComparison.Ordinal);
        Assert.Contains("IUserSecurityStepUpService stepUp", passkeyDelete, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", passkeyDelete, StringComparison.Ordinal);
        Assert.Contains("UserSecurityStepUpActions.PasskeyDelete", passkeyDelete, StringComparison.Ordinal);
        Assert.Contains("IUserSecurityStepUpService stepUp", passkeyRename, StringComparison.Ordinal);
        Assert.Contains("RequireUserSecurityStepUpAsync(", passkeyRename, StringComparison.Ordinal);
        Assert.Contains("UserSecurityStepUpActions.PasskeyCredentialNameUpdate", passkeyRename, StringComparison.Ordinal);

        string combinedHandlers = recoveryCreate + recoveryRotate + passkeyDelete + passkeyRename;
        Assert.DoesNotContain("ValidateAndConsumeProofTokenAsync", combinedHandlers, StringComparison.Ordinal);
        Assert.DoesNotContain("MfaEnabled", combinedHandlers, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaChallengeStart_DoesNotMintBareProofForCredentialMutations()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string mfaStart = ExtractBetween(
            source,
            "group.MapPost(\"/auth/mfa/challenge/start\"",
            "group.MapPost(\"/auth/mfa/challenge\"");

        Assert.Contains("UserSecurityStepUpActions.IsCredentialMutation(action)", mfaStart, StringComparison.Ordinal);
        Assert.Contains("PASSWORD_OR_STEP_UP_PROOF_REQUIRED", mfaStart, StringComparison.Ordinal);
        Assert.True(
            mfaStart.IndexOf("UserSecurityStepUpActions.IsCredentialMutation(action)", StringComparison.Ordinal) <
            mfaStart.IndexOf("CreateProofTokenAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void RecoveryKeyVerifyEndpoint_IsAnonymousPowAndRateLimited()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/auth/recovery-key/verify\"",
            "group.MapPost(\"/auth/recovery-key/passkey/register/begin\"");

        Assert.Contains(".AllowAnonymous()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".RequireNoStoreResponse()", handler, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyVerifyRequest_DoesNotCarryCallerSuppliedUserId()
    {
        string models = ReadSource("src/core/Mapping/Models/ReadModels.cs");
        string userPods = ReadSource("src/shared/Contracts/Models/UserPods.cs");
        string codec = ReadSource("src/core/Cache/PodBinaryCodec.User.cs");
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        string requestPod = ExtractBetween(
            userPods,
            "public readonly struct RecoveryKeyVerifyRequestPod",
            "[StructLayout(LayoutKind.Sequential, Pack = 1)]\npublic readonly struct RecoveryKeyVerifyResponsePod");
        string mutableRequestPod = ExtractBetween(
            codec,
            "private struct MutableRecoveryKeyVerifyRequestPod",
            "[StructLayout(LayoutKind.Sequential, Pack = 1)]\n    private struct MutableRecoveryKeyVerifyResponsePod");
        string responsePod = ExtractBetween(
            userPods,
            "public readonly struct RecoveryKeyVerifyResponsePod",
            "[StructLayout(LayoutKind.Sequential, Pack = 1)]\npublic readonly struct AuthAnonymousBootstrapRequestPod");
        string mutableResponsePod = ExtractBetween(
            codec,
            "private struct MutableRecoveryKeyVerifyResponsePod",
            "private struct MutableAuthAnonymousBootstrapRequestPod");
        string responseWriter = ExtractMethodBlock(codec, "public static void WriteRecoveryKeyVerifyResponse");
        string responseReader = ExtractMethodBlock(codec, "public static bool TryDecodeRecoveryKeyVerifyResponse");
        string verifyHandler = ExtractBetween(
            endpoints,
            "group.MapPost(\"/auth/recovery-key/verify\"",
            "group.MapPost(\"/auth/recovery-key/passkey/register/begin\"");

        Assert.Contains("RecoveryKeyVerifyRequestCoreModel(string RecoveryKey, bool RevokeSessions, bool RevokePasskeys)", models, StringComparison.Ordinal);
        Assert.Contains("RecoveryKeyVerifyResponseCoreModel(string RecoverySessionToken, DateTime ExpiresAt)", models, StringComparison.Ordinal);
        Assert.DoesNotContain("RecoveryKeyVerifyRequestCoreModel(int UserId", models, StringComparison.Ordinal);
        Assert.DoesNotContain("RecoveryKeyVerifyResponseCoreModel(int UserId", models, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", requestPod, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", mutableRequestPod, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", responsePod, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", mutableResponsePod, StringComparison.Ordinal);
        Assert.DoesNotContain("response.UserId", responseWriter, StringComparison.Ordinal);
        Assert.DoesNotContain("pod.UserId", responseReader, StringComparison.Ordinal);
        Assert.DoesNotContain("request.UserId", verifyHandler, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyService_VerifyLocatesCredentialByPepperedLookupHashOnly()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string verifyMethod = ExtractMethodBlock(source, "public async Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync");
        string attemptHelper = ExtractMethodBlock(source, "private static string BuildAttemptIdentity");

        Assert.Contains("LookupIdHash", source, StringComparison.Ordinal);
        Assert.Contains("HashRecoveryKeyLookupId", source, StringComparison.Ordinal);
        Assert.Contains("TryParseRecoveryKeyLookup", verifyMethod, StringComparison.Ordinal);
        Assert.Contains("LoadRecoveryKeyCredentialForUpdateAsync(lookupIdHash", verifyMethod, StringComparison.Ordinal);
        Assert.Contains("WHERE lookup_id_hash = @LookupIdHash", source, StringComparison.Ordinal);
        Assert.DoesNotContain("request.UserId", verifyMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", attemptHelper, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyEntity_DoesNotPersistPlaintextMaterial()
    {
        string source = ReadSource("src/backend/Entities/RecoveryKeyCredential.cs");

        Assert.Contains("KeyHash", source, StringComparison.Ordinal);
        Assert.Contains("LookupIdHash", source, StringComparison.Ordinal);
        Assert.Contains("KeyVersion", source, StringComparison.Ordinal);
        Assert.Contains("UsedAt", source, StringComparison.Ordinal);
        Assert.Contains("RevokedAt", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Plaintext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RecoveryKey { get; set; }", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyCredential_UsesAccountIdColumnAndIndexes()
    {
        PropertyInfo accountId = typeof(RecoveryKeyCredential).GetProperty("AccountId")
            ?? throw new InvalidOperationException("RecoveryKeyCredential.AccountId is required.");

        Assert.Null(typeof(RecoveryKeyCredential).GetProperty("UserId"));
        Assert.Equal("account_id", accountId.GetCustomAttribute<SugarColumn>()?.ColumnName);

        SugarIndexAttribute[] indexes = typeof(RecoveryKeyCredential).GetCustomAttributes<SugarIndexAttribute>().ToArray();
        Assert.Contains(indexes, static index => index.IndexName == "idx_account_recovery_key_account");
        Assert.Contains(indexes, static index => index.IndexName == "idx_account_recovery_key_version");
        Assert.DoesNotContain(indexes, static index => index.IndexName == "idx_account_recovery_key_user");
    }

    [Fact]
    public void RecoveryKeyService_SourceUsesAccountIdForCredentialOwnership()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");

        Assert.Contains("int accountId", source, StringComparison.Ordinal);
        Assert.Contains("k.AccountId", source, StringComparison.Ordinal);
        Assert.Contains("credential.AccountId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RecoveryKeyCredential.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("k.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("credential.UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId = userId", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RecoveryKeyService_AuditMetadataUsesAccountIdentityFieldName()
    {
        string source = ReadSource("src/backend/Services/Security/RecoveryKeyService.cs");
        string encoder = ExtractMethodBlock(source, "private static string EncodeSession");

        Assert.Contains("session.AccountId.ToString", encoder, StringComparison.Ordinal);
        Assert.DoesNotContain("\"UserId\"", encoder, StringComparison.Ordinal);
        Assert.DoesNotContain("session.UserId", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousMfaManagement_RequiresSessionStepUpInsteadOfLegacyPasswordProof()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string userService = ReadSource("src/backend/Services/UserService.cs");

        Assert.Contains("ANONYMOUS_MFA_STEP_UP_REQUIRED", endpoints, StringComparison.Ordinal);
        Assert.Contains("TryReadMfaProof(httpContext, out string proofToken)", endpoints, StringComparison.Ordinal);
        Assert.Contains("ValidateAndConsumeProofTokenAsync(", endpoints, StringComparison.Ordinal);
        Assert.Contains("ResolveAccountSubjectHash", endpoints, StringComparison.Ordinal);
        Assert.Contains("stepUpVerified", userService, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()", userService, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
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
