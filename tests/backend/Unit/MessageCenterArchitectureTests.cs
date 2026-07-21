using System.Reflection;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

using NSubstitute;

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
        IMessageQueryService query = Substitute.For<IMessageQueryService>();
        query.GetAccountConversationsAsync(Arg.Any<int>(), Arg.Any<int>(), Arg.Any<string?>(), Arg.Any<MessageConversationCursor?>(), Arg.Any<CancellationToken>())
            .Returns(new PageResponse<ConversationListItemResponse>());
        query.GetAccountConversationDetailAsync(Arg.Any<int>(), Arg.Any<long>(), Arg.Any<long?>(), Arg.Any<CancellationToken>())
            .Returns(new ConversationDetailResponse());
        query.GetAdminConversationsAsync(Arg.Any<int>(), Arg.Any<string?>(), Arg.Any<MessageConversationCursor?>(), Arg.Any<CancellationToken>())
            .Returns(new PageResponse<AdminConversationListItemResponse>());
        query.GetAdminConversationDetailAsync(Arg.Any<long>(), Arg.Any<long?>(), Arg.Any<CancellationToken>())
            .Returns(new AdminConversationDetailResponse());
        IConfiguration configuration = new ConfigurationBuilder().Build();
        IAedsEncoder aeds = Substitute.For<IAedsEncoder>();
        using var cancellation = new CancellationTokenSource();
        CancellationToken requestToken = cancellation.Token;

        await InvokeHandlerAsync(
            app,
            "/api/binary/messages/conversations",
            20,
            null,
            null,
            query,
            new AccountPrincipalContext(42, "account-session"),
            configuration,
            aeds,
            requestToken);
        await InvokeHandlerAsync(
            app,
            "/api/binary/messages/conversations/{id:long}",
            71L,
            null,
            null,
            query,
            new AccountPrincipalContext(42, "account-session"),
            configuration,
            aeds,
            requestToken);
        await InvokeHandlerAsync(
            app,
            "/api/binary/admin/messages/conversations",
            20,
            null,
            null,
            query,
            configuration,
            aeds,
            requestToken);
        await InvokeHandlerAsync(
            app,
            "/api/binary/admin/messages/conversations/{id:long}",
            71L,
            null,
            query,
            configuration,
            aeds,
            requestToken);

        await query.Received(1).GetAccountConversationsAsync(42, 20, null, null, requestToken);
        await query.Received(1).GetAccountConversationDetailAsync(42, 71, null, requestToken);
        await query.Received(1).GetAdminConversationsAsync(20, null, null, requestToken);
        await query.Received(1).GetAdminConversationDetailAsync(71, null, requestToken);
    }

    private static async Task InvokeHandlerAsync(
        IEndpointRouteBuilder app,
        string route,
        params object?[] arguments)
    {
        RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, HttpMethods.Get);
        MethodInfo handler = Assert.IsAssignableFrom<MethodInfo>(endpoint.Metadata.GetMetadata<MethodInfo>());
        Assert.Contains(handler.GetParameters(), parameter => parameter.ParameterType == typeof(CancellationToken));
        object? target = handler.IsStatic
            ? null
            : handler.DeclaringType?.GetField("<>9", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null);
        Assert.True(handler.IsStatic || target is not null, $"Unable to resolve compiled endpoint target for {route}.");
        Task invocation = Assert.IsAssignableFrom<Task>(handler.Invoke(target, arguments));
        await invocation;
    }
}
