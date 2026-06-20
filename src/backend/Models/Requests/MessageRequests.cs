namespace FsusBlog.Server.Models.Requests;

public sealed record class CreateConversationRequest
{
    public string Subject { get; init; } = string.Empty;
    public string Body { get; init; } = string.Empty;
}

public sealed record class ReplyConversationRequest
{
    public string Body { get; init; } = string.Empty;
}

public sealed record class AdminConversationStatusRequest
{
    public string Status { get; init; } = string.Empty;
}

public sealed record class SendSystemMessageRequest
{
    public long? TargetAccountId { get; init; }
    public string Subject { get; init; } = string.Empty;
    public string Body { get; init; } = string.Empty;
}
