using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core.Communication;

public enum ConversationStatus : short { Open, Pending, Closed }
public enum InboxSender : short { Account, Administrator, System }
public enum InboxEventKind : short { ConversationUpsert = 12, MessageAppend = 13, ReadUpdated = 14 }

public sealed record InboxMessage(long Id, long ConversationId, InboxSender Sender, string Body, DateTimeOffset SentAt);
public sealed record InboxSummary(long Id, string Subject, ConversationStatus Status, bool IsSystem,
    long UnreadCount, DateTimeOffset LastMessageAt, DateTimeOffset UpdatedAt, InboxSender LastSender, string Preview);
public readonly record struct InboxCursor(long SnapshotMessageId, DateTimeOffset LastMessageAt, long ConversationId);
public sealed record InboxPage(IReadOnlyList<InboxSummary> Conversations, long Total, InboxCursor? Next, long ReplayPosition);
public sealed record InboxDetail(long Id, string Subject, ConversationStatus Status, bool IsSystem, long UnreadCount, DateTimeOffset LastMessageAt,
    long? ReadThrough, long ReadSnapshot, long? Previous, IReadOnlyList<InboxMessage> Messages);
public sealed record InboxMutation(InboxMessage Message, bool Replayed);
public sealed record InboxReadState(long ReadThrough, long UnreadCount);
public sealed record InboxEvent(long Sequence, InboxEventKind Kind, long ConversationId, long MessageId, DateTimeOffset OccurredAt);
public sealed record InboxReplay(long Next, bool HasMore, bool RequiresResync, IReadOnlyList<InboxEvent> Events);

public static class InboxRules
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static string Subject(string input, bool system = false) => Validate(
        string.IsNullOrWhiteSpace(input) ? system ? "系统消息" : "用户申诉" : input, 320, 160, 640, "Subject");

    public static string Body(string input) => Validate(input, 8_000, 4_000, 16_000, "Message");

    public static string CommandId(string input)
    {
        var value = input.Trim();
        if (value.Length is < 1 or > 64 || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_' or '.' or ':')))
            throw Invalid("Invalid command key.");
        return value;
    }

    public static string Preview(string body)
    {
        int[] boundaries = StringInfo.ParseCombiningCharacters(body);
        return boundaries.Length <= 96 ? body : string.Concat(body.AsSpan(0, boundaries[96]), "...");
    }

    public static byte[] Fingerprint(string operation, long conversationId, long readThrough, string subject, string body)
        => SHA256.HashData(Utf8.GetBytes(string.Create(CultureInfo.InvariantCulture,
            $"{operation}\0{conversationId}\0{readThrough}\0{subject}\0{body}")));

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);

    private static string Validate(string input, int maxScalars, int maxGraphemes, int maxBytes, string field)
    {
        try
        {
            if (input.Length > maxBytes || string.IsNullOrWhiteSpace(input) || input.Contains('\0') ||
                Utf8.GetByteCount(input) > maxBytes || input.EnumerateRunes().Count() > maxScalars ||
                new StringInfo(input).LengthInTextElements > maxGraphemes)
                throw Invalid($"{field} is empty or exceeds the supported limits.");
        }
        catch (EncoderFallbackException)
        {
            throw Invalid($"{field} must be valid Unicode text.");
        }
        return input;
    }
}
