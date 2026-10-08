using System.Buffers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RecoveryKeyServiceTests
{
    [Fact]
    public void RecoveryKeyService_UsesIndependentPepperedPbkdfHashing()
    {
        MethodInfo hash = PrivateStaticMethod("HashRecoveryKey");
        MethodInfo verify = PrivateStaticMethod("VerifyRecoveryKey");
        byte[] pepper = SHA256.HashData("recovery-pepper-a"u8);
        byte[] wrongPepper = SHA256.HashData("recovery-pepper-b"u8);
        const string RecoveryKey = "frk_0123456789abcdef0123456789abcdef_secret-value";

        string storedHash = Assert.IsType<string>(hash.Invoke(null, [RecoveryKey, pepper]));

        Assert.StartsWith("v1$pbkdf2-sha256$600000$", storedHash, StringComparison.Ordinal);
        Assert.True(Assert.IsType<bool>(verify.Invoke(null, [RecoveryKey, storedHash, pepper])));
        Assert.False(Assert.IsType<bool>(verify.Invoke(null, [RecoveryKey, storedHash, wrongPepper])));
        Assert.DoesNotContain(RecoveryKey, storedHash, StringComparison.Ordinal);
        Assert.DoesNotContain(typeof(RecoveryKeyService).GetConstructors().SelectMany(static ctor => ctor.GetParameters()),
            static parameter => parameter.ParameterType.Name.Contains("Totp", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task RecoveryKeyEndpoints_ExposeBinaryRecoveryFlowAtRuntime()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        string[] routes =
        [
            "/api/binary/auth/recovery-key/create",
            "/api/binary/auth/recovery-key/rotate",
            "/api/binary/auth/recovery-key/verify",
            "/api/binary/auth/recovery-key/passkey/register/begin",
            "/api/binary/auth/recovery-key/passkey/register/complete"
        ];

        foreach (string route in routes)
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, HttpMethods.Post);
            Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());
            Assert.Equal("fixed_ip", Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        }

        Assert.True(Enum.IsDefined(AedsFrameType.RecoveryKeyCreateResponse));
        Assert.True(Enum.IsDefined(AedsFrameType.RecoveryKeyVerifyRequest));
        Assert.True(Enum.IsDefined(AedsFrameType.RecoveryKeyVerifyResponse));
        Assert.True(Enum.IsDefined(AedsFrameType.RecoveryKeySessionRequest));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void CredentialMutationEndpoints_DelegateStepUpToUnifiedService()
    {
        string[] actions =
        [
            UserSecurityStepUpActions.RecoveryKeyCreate,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            UserSecurityStepUpActions.PasskeyDelete,
            UserSecurityStepUpActions.PasskeyCredentialNameUpdate
        ];

        foreach (string action in actions)
        {
            MethodInfo handler = FindBinaryAuthHandlerContaining(action);
            Type[] inputTypes = RuntimeInputTypes(handler);
            Assert.Contains(typeof(IUserSecurityStepUpService), inputTypes);
            Assert.DoesNotContain(typeof(IMfaChallengeService), inputTypes);
            Assert.True(UserSecurityStepUpActions.IsCredentialMutation(action));
        }

        MethodInfo unifiedStepUp = typeof(BinaryEndpoints).GetMethod(
            "RequireUserSecurityStepUpAsync",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Unified user security step-up helper was not found.");
        Assert.Contains(unifiedStepUp.GetParameters(), static parameter =>
            parameter.ParameterType == typeof(IUserSecurityStepUpService));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void MfaChallengeStart_ChecksCredentialMutationBeforeProofMinting()
    {
        MethodInfo handler = FindBinaryAuthHandlerContaining("PASSWORD_OR_STEP_UP_PROOF_REQUIRED");
        IReadOnlyList<(int Offset, MethodBase Method)> calls = ReadCalledMethods(handler);
        int credentialMutationCheck = calls
            .Where(static call => call.Method.DeclaringType == typeof(UserSecurityStepUpActions)
                && call.Method.Name == nameof(UserSecurityStepUpActions.IsCredentialMutation))
            .Select(static call => call.Offset)
            .DefaultIfEmpty(-1)
            .First();
        int proofMint = calls
            .Where(static call => call.Method.DeclaringType == typeof(IMfaChallengeService)
                && call.Method.Name == nameof(IMfaChallengeService.CreateProofTokenAsync))
            .Select(static call => call.Offset)
            .DefaultIfEmpty(-1)
            .First();

        Assert.True(credentialMutationCheck >= 0);
        Assert.True(proofMint > credentialMutationCheck);
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.RecoveryKeyCreate));
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.PasskeyDelete));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task RecoveryKeyVerifyEndpoint_IsAnonymousPowRateLimitedAndNoStore()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/recovery-key/verify",
            HttpMethods.Post);

        Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.Equal("fixed_ip", Assert.IsType<EnableRateLimitingAttribute>(
            endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());
        Assert.Contains(endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>(), static metadata =>
            metadata.FilterType == typeof(RequiresPowFilter));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void RecoveryKeyVerifyRequest_DoesNotCarryCallerSuppliedUserId()
    {
        Assert.Equal(
            ["RecoveryKey", "RevokeSessions", "RevokePasskeys"],
            typeof(RecoveryKeyVerifyRequestCoreModel).GetProperties().Select(static property => property.Name).ToArray());
        Assert.Equal(
            ["RecoverySessionToken", "ExpiresAt"],
            typeof(RecoveryKeyVerifyResponseCoreModel).GetProperties().Select(static property => property.Name).ToArray());
        Assert.DoesNotContain(typeof(RecoveryKeyVerifyRequestPod).GetFields(), static field => field.Name.Contains("UserId", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(RecoveryKeyVerifyResponsePod).GetFields(), static field => field.Name.Contains("UserId", StringComparison.Ordinal));

        var request = new RecoveryKeyVerifyRequestCoreModel("frk_runtime", true, false);
        var requestBuffer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteRecoveryKeyVerifyRequest(request, requestBuffer);
        Assert.True(PodBinaryCodec.TryDecodeRecoveryKeyVerifyRequest(requestBuffer.WrittenMemory, out var decodedRequest));
        Assert.Equal(request, decodedRequest);

        DateTime expiresAt = new(2026, 7, 12, 12, 30, 0, DateTimeKind.Utc);
        var response = new RecoveryKeyVerifyResponseCoreModel("session-token", expiresAt);
        var responseBuffer = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteRecoveryKeyVerifyResponse(response, responseBuffer);
        Assert.True(PodBinaryCodec.TryDecodeRecoveryKeyVerifyResponse(responseBuffer.WrittenMemory, out var decodedResponse));
        Assert.Equal(response, decodedResponse);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-article-recovery-key-service-verify-locates-credential-by-peppered-lookup-hash-only")]
    public void RecoveryKeyService_VerifyLocatesCredentialByPepperedLookupHashOnly()
    {
        MethodInfo parser = PrivateStaticMethod("TryParseRecoveryKeyLookup");
        byte[] pepper = SHA256.HashData("lookup-pepper"u8);
        const string LookupId = "0123456789abcdef0123456789abcdef";
        object?[] arguments = [$"frk_{LookupId}_valid-secret", pepper, null];

        bool parsed = Assert.IsType<bool>(parser.Invoke(null, arguments));
        string lookupHash = Assert.IsType<string>(arguments[2]);

        Assert.True(parsed);
        Assert.Matches("^[0-9A-F]{64}$", lookupHash);
        Assert.DoesNotContain(LookupId, lookupHash, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            [typeof(string), typeof(byte[]), typeof(string).MakeByRefType()],
            parser.GetParameters().Select(static parameter => parameter.ParameterType).ToArray());

        MethodInfo loader = typeof(RecoveryKeyService).GetMethod(
            "LoadRecoveryKeyCredentialForUpdateAsync",
            BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Recovery credential lookup was not found.");
        Assert.Equal(
            [typeof(string), typeof(CancellationToken)],
            loader.GetParameters().Select(static parameter => parameter.ParameterType).ToArray());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void RecoveryKeyEntity_DoesNotPersistPlaintextMaterial()
    {
        string[] properties = typeof(RecoveryKeyCredential)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(static property => property.Name)
            .ToArray();

        Assert.Contains(nameof(RecoveryKeyCredential.KeyHash), properties);
        Assert.Contains(nameof(RecoveryKeyCredential.LookupIdHash), properties);
        Assert.Contains(nameof(RecoveryKeyCredential.KeyVersion), properties);
        Assert.Contains(nameof(RecoveryKeyCredential.UsedAt), properties);
        Assert.Contains(nameof(RecoveryKeyCredential.RevokedAt), properties);
        Assert.DoesNotContain(properties, static name => name.Contains("Plaintext", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain("RecoveryKey", properties);
        Assert.Equal("key_hash", typeof(RecoveryKeyCredential).GetProperty(nameof(RecoveryKeyCredential.KeyHash))!
            .GetCustomAttribute<SugarColumn>()?.ColumnName);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void RecoveryKeyService_UsesAccountIdForCredentialOwnership()
    {
        PropertyInfo accountId = typeof(RecoveryKeyCredential).GetProperty(nameof(RecoveryKeyCredential.AccountId))!;
        Assert.Equal(typeof(int), accountId.PropertyType);
        Assert.Equal("account_id", accountId.GetCustomAttribute<SugarColumn>()?.ColumnName);
        Assert.Null(typeof(RecoveryKeyCredential).GetProperty("UserId"));

        foreach (string methodName in new[] { nameof(IRecoveryKeyService.CreateAsync), nameof(IRecoveryKeyService.RotateAsync) })
        {
            MethodInfo method = typeof(IRecoveryKeyService).GetMethod(methodName)!;
            ParameterInfo ownership = method.GetParameters()[0];
            Assert.Equal("accountId", ownership.Name);
            Assert.Equal(typeof(int), ownership.ParameterType);
        }

        Assert.Equal(
            nameof(RecoveryKeySession.AccountId),
            typeof(RecoveryKeySession).GetProperties()[0].Name);
        Assert.Null(typeof(RecoveryKeySession).GetProperty("UserId"));
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void RecoveryKeyService_SessionEnvelopeRoundTripUsesAccountIdentity()
    {
        var session = new RecoveryKeySession(
            AccountId: 42,
            RevokePasskeys: true,
            IssuedAtUtc: new DateTime(2026, 7, 12, 12, 0, 0, DateTimeKind.Utc),
            ExpiresAtUtc: new DateTime(2026, 7, 12, 12, 10, 0, DateTimeKind.Utc));
        RecoverySessionEnvelope envelope = RecoveryKeyService.ToPendingEnvelope(session);

        string encoded = RecoveryKeyService.EncodeSessionEnvelope(envelope);
        bool decoded = RecoveryKeyService.TryDecodeSessionEnvelope(encoded, out RecoverySessionEnvelope? roundTrip);

        Assert.True(decoded);
        Assert.NotNull(roundTrip);
        Assert.Equal(42, roundTrip!.Session.AccountId);
        Assert.True(roundTrip.Session.RevokePasskeys);
        Assert.Equal(session.IssuedAtUtc, roundTrip.Session.IssuedAtUtc);
        Assert.Equal(session.ExpiresAtUtc, roundTrip.Session.ExpiresAtUtc);
        Assert.StartsWith("v2|pending|42|1|", encoded, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", encoded, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public void AnonymousMfaManagement_RequiresSessionStepUpInsteadOfLegacyPasswordProof()
    {
        MethodInfo[] anonymousMfaHandlers = FindBinaryAuthHandlersContaining("ANONYMOUS_MFA_STEP_UP_REQUIRED");
        Assert.True(anonymousMfaHandlers.Length >= 3);
        foreach (MethodInfo handler in anonymousMfaHandlers)
        {
            Type[] inputTypes = RuntimeInputTypes(handler);
            Assert.Contains(typeof(IMfaChallengeService), inputTypes);
            Assert.Contains(inputTypes, static type => type.Name == "IUserAccountReader");
            Assert.Contains(ReadCalledMethods(handler), static call =>
                call.Method.DeclaringType == typeof(BinaryEndpoints)
                && call.Method.Name == "VerifyMfaManagementStepUpAsync");
        }

        MethodInfo verifyStepUp = typeof(BinaryEndpoints).GetMethod(
            "VerifyMfaManagementStepUpAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains(ReadAsyncCalledMethods(verifyStepUp), static call =>
            call.Method.DeclaringType == typeof(UserMfaStepUpContext)
            && call.Method.Name == nameof(UserMfaStepUpContext.VerifyAsync));
        Assert.Contains(ReadAsyncCalledMethods(typeof(UserMfaStepUpContext).GetMethod(nameof(UserMfaStepUpContext.VerifyAsync))!), static call =>
            call.Method.DeclaringType == typeof(IMfaChallengeService)
            && call.Method.Name == nameof(IMfaChallengeService.ValidateAndConsumeProofTokenAsync));

        foreach (string methodName in new[] { "StartMfaSetupAsync", "DisableMfaAsync", "RegenerateMfaRecoveryCodesAsync" })
        {
            MethodInfo command = typeof(FsusBlog.Server.Services.UserService).GetMethods()
                .Single(method => method.Name == methodName);
            ParameterInfo context = command.GetParameters().Last();
            Assert.Equal(typeof(UserMfaStepUpContext), context.ParameterType);
            Assert.Equal("context", context.Name);
            Assert.False(context.HasDefaultValue);
            Assert.DoesNotContain(command.GetParameters(), static parameter =>
                parameter.Name is "password" or "code" or "recoveryCode" or "stepUpVerified");
        }

        Assert.Empty(typeof(UserMfaStepUpContext).GetConstructors());
        Assert.All(typeof(UserMfaStepUpContext).GetProperties(), static property => Assert.False(property.CanWrite));
    }

    [Theory]
    [InlineData("retired-frame")]
    [InlineData("password-body")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "mfa-management-body-reject-before-service-effects")]
    public async Task MfaManagementEndpoints_RejectLegacyBodiesBeforeAccountProofOrMutationCalls(string bodyKind)
    {
        MethodInfo[] stateMachineHandlers = FindBinaryAuthHandlersContaining("MFA_REQUEST_BODY_NOT_SUPPORTED");
        Assert.Equal(3, stateMachineHandlers.Length);
        foreach (MethodInfo stateMachineHandler in stateMachineHandlers)
        {
            MethodInfo handler = Assert.Single(EnumerateRuntimeMethods(typeof(BinaryEndpoints)), method =>
                method.GetCustomAttribute<System.Runtime.CompilerServices.AsyncStateMachineAttribute>()?.StateMachineType
                    == stateMachineHandler.DeclaringType);
            var commands = Substitute.For<IUserMfaCommandService>();
            var users = Substitute.For<IUserAccountReader>();
            var challenges = Substitute.For<IMfaChallengeService>();
            var system = Substitute.For<ISystemService>();
            var encoder = new AedsEncoder();
            byte[] body;
            if (bodyKind == "retired-frame")
            {
                body = encoder.Encode(AedsFrameType.ArticleList, new byte[28]);
                System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(body.AsSpan(8, 2), 53);
            }
            else
            {
                body = "{\"password\":\"retired-password-proof\"}"u8.ToArray();
            }

            using var services = new ServiceCollection().BuildServiceProvider();
            var http = new DefaultHttpContext { RequestServices = services };
            http.Request.Method = HttpMethods.Post;
            http.Request.ContentType = "application/octet-stream";
            http.Request.ContentLength = body.Length;
            http.Request.Body = new MemoryStream(body);
            http.Request.Headers["X-Fsus-Mfa-Proof"] = "proof-must-not-be-consumed";
            using var responseBody = new MemoryStream();
            http.Response.Body = responseBody;
            object?[] arguments = handler.GetParameters().Select(parameter => parameter.ParameterType switch
            {
                Type type when type == typeof(HttpContext) => (object)http,
                Type type when type == typeof(IUserMfaCommandService) => commands,
                Type type when type == typeof(IUserAccountReader) => users,
                Type type when type == typeof(IMfaChallengeService) => challenges,
                Type type when type == typeof(ISystemService) => system,
                Type type when type == typeof(IAedsEncoder) => encoder,
                _ => throw new InvalidOperationException($"Unexpected current MFA endpoint dependency: {parameter.ParameterType}")
            }).ToArray();
            object? target = handler.IsStatic ? null : Activator.CreateInstance(handler.DeclaringType!, nonPublic: true);
            var pending = Assert.IsAssignableFrom<Task<BinaryFrameResult>>(handler.Invoke(target, arguments));

            BinaryFrameResult result = await pending;
            await result.ExecuteAsync(http);

            Assert.Equal(StatusCodes.Status400BadRequest, http.Response.StatusCode);
            var decoded = encoder.TryDecode(responseBody.ToArray());
            Assert.True(decoded.IsSuccess);
            Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
            Assert.Contains("MFA_REQUEST_BODY_NOT_SUPPORTED", Encoding.UTF8.GetString(responseBody.ToArray()), StringComparison.Ordinal);
            Assert.Empty(users.ReceivedCalls());
            Assert.Empty(challenges.ReceivedCalls());
            Assert.Empty(commands.ReceivedCalls());
            Assert.Empty(system.ReceivedCalls());
        }
    }

    private static MethodInfo PrivateStaticMethod(string name)
        => typeof(RecoveryKeyService).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Recovery key runtime method was not found: {name}");

    private static MethodInfo FindBinaryAuthHandlerContaining(string literal)
        => Assert.Single(FindBinaryAuthHandlersContaining(literal));

    private static MethodInfo[] FindBinaryAuthHandlersContaining(string literal)
        => EnumerateRuntimeMethods(typeof(BinaryEndpoints))
            .Where(method => ContainsStringLiteral(method, literal))
            .ToArray();

    private static IEnumerable<MethodInfo> EnumerateRuntimeMethods(Type root)
    {
        foreach (MethodInfo method in root.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance))
        {
            yield return method;
        }

        foreach (Type nested in root.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (MethodInfo method in EnumerateRuntimeMethods(nested))
            {
                yield return method;
            }
        }
    }

    private static bool ContainsStringLiteral(MethodInfo method, string expected)
    {
        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return false;
        }

        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] != 0x72)
            {
                continue;
            }

            try
            {
                string literal = method.Module.ResolveString(BitConverter.ToInt32(il, offset + 1));
                if (string.Equals(literal, expected, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            catch (ArgumentException)
            {
            }
        }

        return false;
    }

    private static IReadOnlyList<(int Offset, MethodBase Method)> ReadCalledMethods(MethodInfo method)
    {
        var calls = new List<(int Offset, MethodBase Method)>();
        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return calls;
        }

        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
            {
                continue;
            }

            try
            {
                MethodBase? called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
                if (called is not null)
                {
                    calls.Add((offset, called));
                }
            }
            catch (ArgumentException)
            {
            }
        }

        return calls;
    }

    private static IReadOnlyList<(int Offset, MethodBase Method)> ReadAsyncCalledMethods(MethodInfo method)
    {
        Type stateMachine = method.GetCustomAttribute<System.Runtime.CompilerServices.AsyncStateMachineAttribute>()!.StateMachineType;
        MethodInfo moveNext = stateMachine.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Instance)!;
        return ReadCalledMethods(moveNext);
    }

    private static Type[] RuntimeInputTypes(MethodInfo method)
        => method.GetParameters().Select(static parameter => parameter.ParameterType)
            .Concat(method.DeclaringType?.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Select(static field => field.FieldType) ?? [])
            .Distinct()
            .ToArray();

}
