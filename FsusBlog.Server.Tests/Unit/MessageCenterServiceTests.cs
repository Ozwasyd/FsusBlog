using FsusBlog.Server.Services.Sse;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class MessageCenterServiceTests
{
    [Fact]
    public void BuildLatestMessageMap_PicksMappedLatestMessagePerConversation()
    {
        IReadOnlyList<(long ConversationId, long MessageId)> latestRows =
        [
            (10, 1001),
            (20, 2002),
            (30, 3003)
        ];

        IReadOnlyDictionary<long, ConversationMessagePreviewResponse> mappedByMessageId =
            new Dictionary<long, ConversationMessagePreviewResponse>
            {
                [1001] = new() { SenderName = "u1", BodyPreview = "first", CreatedAt = DateTime.UtcNow },
                [3003] = new() { SenderName = "u3", BodyPreview = "third", CreatedAt = DateTime.UtcNow }
            };

        Dictionary<long, ConversationMessagePreviewResponse> result =
            MessageCenterService.BuildLatestMessageMap(latestRows, mappedByMessageId);

        Assert.Equal(2, result.Count);
        Assert.Equal("first", result[10].BodyPreview);
        Assert.Equal("third", result[30].BodyPreview);
        Assert.False(result.ContainsKey(20));
    }
}
