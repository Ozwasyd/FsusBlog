using System.Reflection;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MessageCenterArchitectureTests
{
    private static readonly IReadOnlyDictionary<string, string[]> s_responsibilities =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["MessageCenterService.ConversationQuery.cs"] =
            [
                "GetAccountConversationsAsync",
                "GetAdminConversationDetailAsync",
                "LoadSnapshotConversationRowsAsync"
            ],
            ["MessageCenterService.MessageCommand.cs"] =
            [
                "CreateAccountTicketAsync",
                "WriteReplyAsync",
                "SendSystemMessageAsync"
            ],
            ["MessageCenterService.ReadState.cs"] =
            [
                "MarkConversationReadAsync",
                "RebuildConversationUnreadAsync",
                "RebuildAccountUnreadAsync"
            ],
            ["MessageCenterService.DeliveryOutbox.cs"] =
            [
                "EnqueueMessageDeliveriesAsync",
                "DeliverAsync"
            ],
            ["MessageCenterService.Projection.cs"] =
            [
                "PublishConversationUpsertAsync",
                "PrepareParticipantMessageFanoutAsync",
                "RefreshUnreadCacheAsync"
            ],
            ["MessageCenterService.ContentPolicy.cs"] =
            [
                "ToContentValidationCode",
                "TryNormalizeClientMutationId",
                "ComputeMutationRequestHash"
            ]
        };

    [Fact]
    public void ResponsibilityFilesOwnExplicitMessageCenterBoundaries()
    {
        string directory = BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "NotificationStream");

        foreach ((string fileName, string[] members) in s_responsibilities)
        {
            string source = File.ReadAllText(Path.Combine(directory, fileName));
            Assert.Contains("public sealed partial class MessageCenterService", source, StringComparison.Ordinal);
            foreach (string member in members)
            {
                Assert.Contains(member, source, StringComparison.Ordinal);
            }
        }

        string facade = File.ReadAllText(Path.Combine(directory, "MessageCenterService.cs"));
        Assert.Contains("public sealed partial class MessageCenterService(", facade, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAccountConversationsAsync(", facade, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateAccountTicketAsync(", facade, StringComparison.Ordinal);
        Assert.DoesNotContain("DeliverAsync(", facade, StringComparison.Ordinal);
        Assert.True(
            File.ReadLines(Path.Combine(directory, "MessageCenterService.cs")).Count() < 500,
            "MessageCenterService facade must stay below 500 lines.");
    }

    [Fact]
    public void ReplyCommandsShareOneTransactionalWriteKernel()
    {
        string commandSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "NotificationStream",
            "MessageCenterService.MessageCommand.cs"));

        Assert.Contains("private async Task<ReplyWriteOutcome> WriteReplyAsync", commandSource, StringComparison.Ordinal);
        Assert.Equal(3, CountOccurrences(commandSource, "WriteReplyAsync("));
        Assert.DoesNotContain("notificationStreamPort.Publish", commandSource, StringComparison.Ordinal);
    }

    [Fact]
    public void QueryPortAndEndpointsCarryRequestCancellation()
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

        string endpointSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Messages.cs"));
        Assert.Contains("GetAccountConversationsAsync(account.AccountId, pageSize, filter, position, cancellationToken)", endpointSource, StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationDetailAsync(account.AccountId, id, beforeMessageId, cancellationToken)", endpointSource, StringComparison.Ordinal);
        Assert.Contains("GetAdminConversationsAsync(pageSize, filter, position, cancellationToken)", endpointSource, StringComparison.Ordinal);
        Assert.Contains("GetAdminConversationDetailAsync(id, beforeMessageId, cancellationToken)", endpointSource, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int offset = 0;
        while ((offset = source.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += value.Length;
        }

        return count;
    }
}
