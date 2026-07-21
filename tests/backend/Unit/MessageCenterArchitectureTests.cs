using System.Reflection;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MessageCenterArchitectureTests
{
    private static readonly string[][] s_responsibilityMembers =
        [
            [
                "GetAccountConversationsAsync",
                "GetAdminConversationDetailAsync",
                "LoadSnapshotConversationRowsAsync"
            ],
            [
                "CreateAccountTicketAsync",
                "WriteReplyAsync",
                "SendSystemMessageAsync"
            ],
            [
                "MarkConversationReadAsync",
                "RebuildConversationUnreadAsync",
                "RebuildAccountUnreadAsync"
            ],
            [
                "EnqueueMessageDeliveriesAsync",
                "DeliverAsync"
            ],
            [
                "PublishConversationUpsertAsync",
                "PrepareParticipantMessageFanoutAsync",
                "RefreshUnreadCacheAsync"
            ],
            [
                "ToContentValidationCode",
                "TryNormalizeClientMutationId",
                "ComputeMutationRequestHash"
            ]
        ];

    [Fact]
    public void ResponsibilityFilesOwnExplicitMessageCenterBoundaries()
    {
        MethodInfo[] runtimeMethods = typeof(MessageCenterService).GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        foreach (string[] members in s_responsibilityMembers)
        {
            foreach (string member in members)
            {
                Assert.Contains(runtimeMethods, method => method.Name == member);
            }
        }

        Assert.True(typeof(MessageCenterService).IsSealed);
        Assert.All(runtimeMethods, method => Assert.Equal(typeof(MessageCenterService), method.DeclaringType));
    }

    [Fact]
    public void ReplyCommandsShareOneTransactionalWriteKernel()
    {
        string accountReply = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.ReplyAsAccountAsync));
        string adminReply = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.ReplyAsAdminAsync));
        string kernel = RuntimeMetadataInspection.DescribeMethods(typeof(MessageCenterService), "WriteReplyAsync");

        Assert.Contains("WriteReplyAsync", accountReply, StringComparison.Ordinal);
        Assert.Contains("WriteReplyAsync", adminReply, StringComparison.Ordinal);
        Assert.Contains("ReplyWriteOutcome", kernel, StringComparison.Ordinal);
        Assert.DoesNotContain("IMessageNotificationStreamPort.Publish", kernel, StringComparison.Ordinal);
    }

    [Fact]
    public async Task QueryPortAndEndpointsCarryRequestCancellation()
    {
        MethodInfo[] methods = typeof(IMessageQueryService).GetMethods();
        Assert.NotEmpty(methods);
        foreach (MethodInfo method in methods)
        {
            ParameterInfo parameter = Assert.Single(
                method.GetParameters(),
                static candidate => candidate.ParameterType == typeof(CancellationToken));
            Assert.True(parameter.HasDefaultValue);
            Assert.Equal(method.GetParameters().Length - 1, parameter.Position);
        }

        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        foreach ((string route, string method) in new[]
        {
            ("/api/binary/messages/conversations", HttpMethods.Get),
            ("/api/binary/messages/conversations/{id:long}", HttpMethods.Get),
            ("/api/binary/admin/messages/conversations", HttpMethods.Get),
            ("/api/binary/admin/messages/conversations/{id:long}", HttpMethods.Get)
        })
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, method);
            MethodInfo handler = Assert.IsAssignableFrom<MethodInfo>(endpoint.Metadata.GetMetadata<MethodInfo>());
            Assert.Contains(handler.GetParameters(), parameter => parameter.ParameterType == typeof(CancellationToken));
        }
    }
}
