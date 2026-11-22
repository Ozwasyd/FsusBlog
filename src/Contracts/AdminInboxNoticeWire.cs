namespace FsusBlog.V2.Contracts;

public sealed record AdminInboxNotice(Guid Account, string Subject, string Body);

public static partial class Wire
{
    public const int MaxAdminInboxNoticeFrameBytes = Aeds.HeaderSize + 16 + 8 + 640 + 16000;

    public static byte[] EncodeAdminInboxNotice(AdminInboxNotice notice)
    {
        if (notice.Account == Guid.Empty) throw InvalidNotice();
        var writer = new Writer();
        writer.Uuid(notice.Account);
        writer.Text(notice.Subject, 640);
        writer.Text(notice.Body, 16000);
        return Aeds.Encode(FrameType.AdminInboxNotice, writer.Written);
    }

    public static AdminInboxNotice DecodeAdminInboxNotice(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.AdminInboxNotice, MaxAdminInboxNoticeFrameBytes, InvalidNotice);
        var account = reader.Uuid();
        if (account == Guid.Empty) throw InvalidNotice();
        var notice = new AdminInboxNotice(account, reader.Text(640), reader.Text(16000));
        reader.Finish();
        return notice;
    }

    private static ProtocolException InvalidNotice() => new("Invalid administrator system notice.");
}
