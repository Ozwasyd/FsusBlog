using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentRiskControlContractTests
{
    [Fact]
    public void CommentCreateEndpoint_RoutesCreateAndReplyThroughRiskControlBeforeLegacyPow()
    {
        string source = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string handler = ExtractBetween(
            source,
            "group.MapPost(\"/comment\"",
            "group.MapGet(\"/comment/{articleId:int}\"");

        Assert.Contains(".WithRiskAction(RiskActionNames.CommentCreate)", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<CommentRiskActionFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresRiskControlFilter>()", handler, StringComparison.Ordinal);
        Assert.Contains(".AddEndpointFilter<RequiresPowFilter>()", handler, StringComparison.Ordinal);

        Assert.True(
            handler.IndexOf("CommentRiskActionFilter", StringComparison.Ordinal) <
            handler.IndexOf("RequiresRiskControlFilter", StringComparison.Ordinal),
            "comment risk action filter must set dynamic create/reply action before RequiresRiskControlFilter runs.");
    }

    [Fact]
    public void CommentRiskActionFilter_DecodesCreateAndReplyWithoutChangingAnonymousIdentityPayload()
    {
        string source = ReadSource("src/backend/Infrastructure/Filters/CommentRiskActionFilter.cs");

        Assert.Contains("AedsFrameType.CommentCreateV2Request", source, StringComparison.Ordinal);
        Assert.Contains("TryDecodeCommentCreateV2Request", source, StringComparison.Ordinal);
        Assert.Contains("RiskActionNames.CommentReply", source, StringComparison.Ordinal);
        Assert.Contains("RiskActionNames.CommentCreate", source, StringComparison.Ordinal);
        Assert.Contains("Request.Body.Position = 0", source, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PublicHandle", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CommentRiskActionFilter_SetsReplyActionAndResetsRequestBody()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(
            AedsFrameType.CommentCreateV2Request,
            PodBinaryCodec.EncodeCommentCreateV2Request(new CommentCreateV2RequestCoreModel(
                ArticleId: 42,
                Content: "reply",
                ParentId: "100",
                RootId: "100",
                ReplyToCommentId: "100",
                ReplyToUserId: 7,
                AuthorMode: "anonymous",
                PublicSendExplicitlySelected: false,
                AnonymousScope: null,
                DisplayLanguage: null,
                ProofToken: null,
                ZkProof: [])));
        var context = new DefaultHttpContext();
        context.Request.Body = new MemoryStream(frame);
        context.Request.ContentLength = frame.Length;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);
        bool nextCalled = false;

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                Assert.Equal(0, context.Request.Body.Position);
                RiskActionEndpointMetadata metadata = Assert.IsType<RiskActionEndpointMetadata>(
                    context.Items[RiskActionEndpointMetadata.HttpContextItemKey]);
                Assert.Equal(RiskActionNames.CommentReply, metadata.ActionName);
                Assert.Equal("comment.reply", metadata.RouteKey);
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("ok", result);
    }

    [Fact]
    public void RiskControlContextFactory_PrefersDynamicCommentRiskActionMetadata()
    {
        var context = new DefaultHttpContext();
        context.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(RiskActionNames.CommentReply);

        RiskControlContext riskContext = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskActionNames.CommentReply, riskContext.ActionName);
        Assert.Equal("comment.reply", riskContext.RouteKey);
    }

    [Fact]
    public void RequiresRiskControlFilter_QueuesModerationInsteadOfRejectingComments()
    {
        string source = ReadSource("src/backend/Infrastructure/Filters/RequiresRiskControlFilter.cs");

        Assert.Contains("RiskDecisionKind.QueueForModeration => await QueueForModerationAsync(context, next, decision)", source, StringComparison.Ordinal);
        Assert.Contains("RiskControlDecisionContext.HttpContextItemKey", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RiskDecisionKind.QueueForModeration or RiskDecisionKind.Throttle => await RejectAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentCreateHandler_RecordsRiskControlQueueReasonAndCommentRiskSignals()
    {
        string endpoint = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string service = ReadSource("src/backend/Services/CommentService.cs");
        string abstractions = ReadSource("src/backend/Infrastructure/Security/SecurityRiskAbstractions.cs");

        Assert.Contains("ApplyRiskControlModerationDecision", endpoint, StringComparison.Ordinal);
        Assert.Contains("RecordCommentRiskSignalAsync", endpoint, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.CommentRegionCompliance", endpoint, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.CommentSpamPattern", endpoint, StringComparison.Ordinal);
        Assert.Contains("risk_control_queue", service, StringComparison.Ordinal);
        Assert.Contains("CommentRegionCompliance", abstractions, StringComparison.Ordinal);
        Assert.Contains("CommentSpamPattern", abstractions, StringComparison.Ordinal);
        Assert.Contains("CommentNullifierAbuse", abstractions, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private sealed class TestEndpointFilterInvocationContext(HttpContext httpContext) : EndpointFilterInvocationContext
    {
        public override HttpContext HttpContext { get; } = httpContext;

        public override IList<object?> Arguments { get; } = [];

        public override T GetArgument<T>(int index) => (T)Arguments[index]!;
    }
}
