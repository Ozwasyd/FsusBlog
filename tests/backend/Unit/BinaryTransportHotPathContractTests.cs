using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryTransportHotPathContractTests
{
    [Fact]
    public void NotificationStream_SourceAvoidsGlobalConnectionGateAndSnapshotsFanout()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/NotificationStream/NotificationStreamConnectionManager.cs");

        Assert.DoesNotContain("_indexGate", source, StringComparison.Ordinal);
        Assert.DoesNotContain("lock (_indexGate)", source, StringComparison.Ordinal);
        Assert.Contains("ResolveConnectionsSnapshot", source, StringComparison.Ordinal);
        Assert.Contains("connectionIds.ToArray()", source, StringComparison.Ordinal);
        Assert.Contains("Channel.CreateBounded<SharedNotificationStreamFrame>", source, StringComparison.Ordinal);
    }

    [Fact]
    public void NotificationStreamFramePump_SourceWritesFrameMemoryWithoutPerFrameArray()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/NotificationStream/NotificationStreamFramePump.cs");
        string method = ExtractMethodBlock(source, "internal static int WriteDequeuedFrame");

        Assert.Contains("frame.Memory.Span.CopyTo(writer.GetSpan(frameLength))", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".ToArray()", method, StringComparison.Ordinal);
        Assert.Contains("finally", method, StringComparison.Ordinal);
        Assert.Contains("frame.Release()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthoringAndSecurityAdminRoutes_DoNotUseRuntimeBinaryBridgeMiddlewares()
    {
        string composition = ReadRepoFile("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs");
        string authoring = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string security = ReadRepoFile("src/backend/Modules/Endpoints/SecurityEndpoints.cs");

        Assert.DoesNotContain("BinaryBridgeMiddleware", composition, StringComparison.Ordinal);
        Assert.DoesNotContain("BridgeToLegacy", authoring, StringComparison.Ordinal);
        Assert.DoesNotContain("BridgeToLegacy", security, StringComparison.Ordinal);
        Assert.Contains("app.MapGroup(BinaryPrefix)", authoring, StringComparison.Ordinal);
        Assert.Contains("app.MapGroup(BinaryPrefix)", security, StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryRequestBinder_SourceUsesPipeReaderAndOnePooledPayloadCopy()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Binary/BinaryRequestBinder.cs");

        Assert.Contains("BodyReader.ReadAtLeastAsync", source, StringComparison.Ordinal);
        Assert.Contains("ReadOnlySequence<byte>", source, StringComparison.Ordinal);
        Assert.Contains("ArrayPool<byte>.Shared.Rent((int)payloadLength)", source, StringComparison.Ordinal);
        Assert.Contains("payloadLength > frameLimit - AedsFrameHeader.Size", source, StringComparison.Ordinal);
        Assert.DoesNotContain("new MemoryStream", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".ToArray()", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentBinaryHandlers_SourceUsesStaticHandlersAndDirectFrameEncodingOnCacheMiss()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");

        Assert.Contains("group.MapGet(\"/comment/{articleId:int}\", static async Task<IResult>", source, StringComparison.Ordinal);
        Assert.Contains("group.MapGet(\"/comment/{articleId:int}/thread/{rootId:long}\", static async Task<IResult>", source, StringComparison.Ordinal);
        Assert.Contains("group.MapGet(\"/comment/me\", static async Task<IResult>", source, StringComparison.Ordinal);
        Assert.Contains("EncodeCachedFrame(AedsFrameType.CommentArticleCursor", source, StringComparison.Ordinal);
        Assert.Contains("EncodeCachedFrame(AedsFrameType.CommentThreadReplyCursor", source, StringComparison.Ordinal);
        Assert.Contains("EncodeCachedFrame(AedsFrameType.CommentUserCursor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("byte[] payload = PodBinaryCodec.EncodeCommentThreadCursor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("byte[] payload = PodBinaryCodec.EncodeCommentReplyCursor", source, StringComparison.Ordinal);
        Assert.DoesNotContain("byte[] payload = PodBinaryCodec.EncodeUserCommentCursor", source, StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryMutationAndAuthHandlers_SourcePropagatesCancellationTokens()
    {
        string articleEndpoints = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs");
        string articleInterface = ReadRepoFile("src/backend/Interfaces/IArticleEndpointService.cs");
        string authEndpoints = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string authAdapters = ReadRepoFile("src/backend/Modules/Endpoints/Binary/AuthBinaryEndpointAdapters.cs");
        string authFacade = ReadRepoFile("src/backend/Services/AuthBinaryApplicationFacade.cs");

        Assert.Contains("ClearTrashAsync(cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("DeleteAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("RestoreAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("PermanentlyDeleteArticleAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("Task<int> ClearTrashAsync(CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);

        Assert.Contains("authFacade.BootstrapAnonymousAccountAsync(request.Value, AuthBinaryClientContext.From(httpContext), cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("sessions.RefreshTokenWithExpiryAsync(oldRefreshToken, sessionId, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("sessions.RevokeRefreshTokenAsync(refreshToken, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("passkeyService.RemoveCredentialAsync(userId, id, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("removeResult.Success", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("passkeyService.RenameCredentialAsync(userId, id, name, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("Task<AuthBinaryFlowResult> BootstrapAnonymousAccountAsync(AuthAnonymousBootstrapRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)", authFacade, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AuthAnonymousBootstrapRequest", authAdapters, StringComparison.Ordinal);
        Assert.Contains("group.MapPost(\"/auth/anonymous/bootstrap\"", authEndpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void BinaryPasswordLoginAndRegister_AreNotProductionAuthCapabilities()
    {
        string authEndpoints = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");
        string authAdapters = ReadRepoFile("src/backend/Modules/Endpoints/Binary/AuthBinaryEndpointAdapters.cs");
        string authFacade = ReadRepoFile("src/backend/Services/AuthBinaryApplicationFacade.cs");
        string openApi = ReadRepoFile("src/shared/Contracts/Validation/fsusblog.openapi.json");
        string matrix = ReadRepoFile("tests/frontend/fixtures/cross-stack-contract-matrix.json");
        string golden = ReadRepoFile("tests/backend/Fixtures/aeds-golden-catalog.json");

        Assert.DoesNotContain("group.MapPost(\"/auth/login\"", authEndpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("group.MapPost(\"/auth/register\"", authEndpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadLoginAsync", authAdapters, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadRegisterAsync", authAdapters, StringComparison.Ordinal);
        Assert.DoesNotContain("LoginAsync(AuthLoginRequestCoreModel", authFacade, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisterAsync(AuthRegisterRequestCoreModel", authFacade, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary/auth/login", openApi, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary/auth/register", openApi, StringComparison.Ordinal);
        Assert.DoesNotContain("\"path\": \"/auth/login\"", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("\"path\": \"/auth/register\"", matrix, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthLoginRequest", golden, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthRegisterRequest", golden, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthUpdatePasswordRequest", golden, StringComparison.Ordinal);
        Assert.Contains("\"value\": 43, \"reason\": \"legacy-password-login\"", golden, StringComparison.Ordinal);
        Assert.Contains("\"value\": 44, \"reason\": \"legacy-password-register\"", golden, StringComparison.Ordinal);
        Assert.Contains("\"value\": 45, \"reason\": \"legacy-username-mutation\"", golden, StringComparison.Ordinal);
        Assert.Contains("\"value\": 46, \"reason\": \"legacy-password-mutation\"", golden, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyPasswordAuthFrames_AreRetiredAcrossProtocolCatalogsAndCodecs()
    {
        string protocol = ReadRepoFile("src/shared/Contracts/Validation/aeds-protocol.json");
        string coreEnum = ReadRepoFile("src/core/Algorithms/AedsFrameType.cs");
        string sharedEnum = ReadRepoFile("src/shared/AedsFrameHeader.cs");
        string frontendFrameMirror = ReadRepoFile("src/frontend/wasm/web/protocol/frame.ts");
        string golden = ReadRepoFile("tests/backend/Fixtures/aeds-golden-catalog.json");
        string codec = ReadRepoFile("src/core/Cache/PodBinaryCodec.User.cs");

        string combinedProtocolSurface = string.Join('\n', protocol, coreEnum, sharedEnum, frontendFrameMirror, golden);

        foreach (string retiredFrame in new[]
        {
            "AuthLoginRequest",
            "AuthRegisterRequest",
            "AuthUpdateUsernameRequest",
            "AuthUpdatePasswordRequest"
        })
        {
            Assert.DoesNotContain(retiredFrame, combinedProtocolSurface, StringComparison.Ordinal);
            Assert.DoesNotContain(retiredFrame, codec, StringComparison.Ordinal);
        }

        foreach (string requiredFrame in new[]
        {
            "AuthAnonymousBootstrapRequest",
            "PasskeyRegisterBegin",
            "PasskeyLoginBegin",
            "PasskeyRegisterCompleteRequest",
            "PasskeyLoginCompleteRequest",
            "RecoveryKeyCreateResponse",
            "RecoveryKeyVerifyRequest",
            "RecoveryKeyVerifyResponse",
            "RecoveryKeySessionRequest",
            "MfaSetupStart",
            "MfaSetupVerify",
            "MfaProfile",
            "MfaChallengeResult",
            "MfaSetupVerifyRequest",
            "MfaChallengeStartRequest",
            "MfaChallengeVerifyRequest",
            "AdminPrincipalSnapshot"
        })
        {
            Assert.Contains(requiredFrame, combinedProtocolSurface, StringComparison.Ordinal);
        }
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing method signature: {signature}");

        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart >= 0, $"Missing method body: {signature}");

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
