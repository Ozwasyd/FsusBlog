namespace FsusBlog.V2.Contracts;

public sealed record AdminInboxRow(long Id, Guid Account, string Subject, int Status, bool System, long UpdatedAt,
    int Unread = 0);
public sealed record AdminInboxPage(IReadOnlyList<AdminInboxRow> Rows, string? Next);
public sealed record AdminInboxMessage(long Id, int Sender, bool Internal, long At, string Body);
public sealed record AdminInboxThread(AdminInboxRow Conversation, IReadOnlyList<AdminInboxMessage> Messages, string? Previous,
    string? Version = null, string? ReadSnapshot = null);

public static partial class Wire
{
    public const int AdminInboxPageSize = 24;
    public const int AdminInboxThreadSize = 24;

    public static byte[] EncodeAdminInboxPage(AdminInboxPage page, bool shared = false)
    {
        if (page.Rows.Count > AdminInboxPageSize || page.Next is not null && page.Rows.Count != AdminInboxPageSize)
            throw new ProtocolException("Invalid administrator inbox page.");
        var writer = new Writer();
        writer.Text(page.Next ?? "", 100);
        writer.I32(page.Rows.Count);
        foreach (var row in page.Rows) WriteAdminInboxRow(writer, row, shared);
        return Aeds.Encode(shared ? FrameType.AdminInboxSharedPage : FrameType.AdminInboxPage, writer.Written);
    }

    public static byte[] EncodeAdminInboxThread(AdminInboxThread thread, bool shared = false)
    {
        if (thread.Messages.Count is < 1 or > AdminInboxThreadSize || thread.Previous is not null && thread.Messages.Count != AdminInboxThreadSize)
            throw new ProtocolException("Invalid administrator inbox thread.");
        var writer = new Writer();
        WriteAdminInboxRow(writer, thread.Conversation, shared);
        writer.Text(thread.Previous ?? "", 100);
        writer.I32(thread.Messages.Count);
        long previous = 0;
        foreach (var message in thread.Messages)
        {
            if (message.Id <= previous || message.At <= 0 || message.Sender is < 0 or > 2 || message.Body.Length == 0)
                throw new ProtocolException("Invalid administrator inbox message.");
            writer.I64(message.Id);
            writer.I32(message.Sender);
            writer.Bool(message.Internal);
            writer.I64(message.At);
            writer.Text(message.Body, 16000);
            previous = message.Id;
        }
        return Aeds.Encode(shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread, writer.Written);
    }

    private static void WriteAdminInboxRow(Writer writer, AdminInboxRow row, bool shared)
    {
        if (row.Id <= 0 || row.Account == Guid.Empty || row.Subject.Length == 0 || row.Status is < 0 or > 2 || row.UpdatedAt <= 0)
            throw new ProtocolException("Invalid administrator inbox conversation.");
        writer.I64(row.Id);
        writer.Uuid(row.Account);
        writer.Text(row.Subject, 640);
        writer.I32(row.Status);
        writer.Bool(row.System);
        writer.I64(row.UpdatedAt);
        if (shared)
        {
            if (row.Unread < 0) throw new ProtocolException("Invalid administrator unread count.");
            writer.I32(row.Unread);
        }
    }
}
