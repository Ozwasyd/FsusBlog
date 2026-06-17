using System.Runtime.CompilerServices;

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
    public void BinaryBridgeMiddlewares_SourceAvoidMemoryStreamToArrayDoubleCopy()
    {
        AssertBridgeUsesPooledBuffer("src/backend/Infrastructure/Middlewares/SecurityBinaryBridgeMiddleware.cs");
        AssertBridgeUsesPooledBuffer("src/backend/Infrastructure/Middlewares/AuthoringBinaryBridgeMiddleware.cs");
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
        string authFacade = ReadRepoFile("src/backend/Services/AuthBinaryApplicationFacade.cs");

        Assert.Contains("ClearTrashAsync(cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("DeleteAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("RestoreAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("PermanentlyDeleteArticleAsync(id, cancellationToken)", articleEndpoints, StringComparison.Ordinal);
        Assert.Contains("Task<int> ClearTrashAsync(CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);
        Assert.Contains("Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default)", articleInterface, StringComparison.Ordinal);

        Assert.Contains("authFacade.LoginAsync(request.Value, AuthBinaryClientContext.From(httpContext), cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("authFacade.RegisterAsync(request.Value, AuthBinaryClientContext.From(httpContext), cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("sessions.RefreshTokenWithExpiryAsync(oldRefreshToken, sessionId, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("sessions.RevokeRefreshTokenAsync(refreshToken, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("passkeyService.RemoveCredentialAsync(userId, id, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("removeResult.Success", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("passkeyService.RenameCredentialAsync(userId, id, name, cancellationToken)", authEndpoints, StringComparison.Ordinal);
        Assert.Contains("Task<AuthBinaryFlowResult> LoginAsync(AuthLoginRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)", authFacade, StringComparison.Ordinal);
        Assert.Contains("Task<AuthBinaryFlowResult> RegisterAsync(AuthRegisterRequestCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default)", authFacade, StringComparison.Ordinal);
    }

    private static void AssertBridgeUsesPooledBuffer(string relativePath)
    {
        string source = ReadRepoFile(relativePath);
        string bridge = ExtractMethodBlock(source, "private async Task BridgeToLegacy");
        string readBody = ExtractMethodBlock(source, "private static async Task<PooledBinaryBridgeBuffer> ReadBodyWithLimitAsync");

        Assert.Contains("PooledBinaryBridgeBuffer", source, StringComparison.Ordinal);
        Assert.Contains("ReadOnlyMemoryStream", source, StringComparison.Ordinal);
        Assert.DoesNotContain("await using var capture = new MemoryStream", bridge, StringComparison.Ordinal);
        Assert.DoesNotContain("new MemoryStream(json.ToArray())", bridge, StringComparison.Ordinal);
        Assert.DoesNotContain("capture.ToArray()", bridge, StringComparison.Ordinal);
        Assert.DoesNotContain("using var buffer = new MemoryStream", readBody, StringComparison.Ordinal);
        Assert.DoesNotContain("return buffer.ToArray()", readBody, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

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

    private static string FindRepoRoot([CallerFilePath] string sourceFilePath = "")
    {
        string? current = Path.GetDirectoryName(sourceFilePath);
        if (string.IsNullOrWhiteSpace(current))
        {
            current = AppContext.BaseDirectory;
        }

        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                Directory.Exists(Path.Combine(current, ".git")))
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
