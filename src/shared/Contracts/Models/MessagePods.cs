using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MessageInboxPod
{
    public readonly int Category;
    public readonly byte IsRead;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 Id;
    public readonly Utf8Fixed128 CategoryName;
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPushPod
{
    public readonly long Id;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentAddedNotifyPod
{
    public readonly int ArticleId;
    public readonly int Reserved;
    public readonly long TimeUnixMs;
    public readonly CommentPushPod Comment;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct GlobalNoticePayloadPod
{
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed64 Id;
    public readonly Utf8Fixed256 Title;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MessageRevokedPayloadPod
{
    public readonly Utf8Fixed64 MessageId;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserStatusPayloadPod
{
    public readonly int Status;
    public readonly long TimeUnixMs;
    public readonly Utf8SliceRef Reason;
    public readonly byte HasReason;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct NoticePayloadPod
{
    public readonly int UnreadCount;
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed256 Title;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentRemovedPayloadPod
{
    public readonly int ArticleId;
    public readonly int Reserved;
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed64 CommentId;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MessageInboxListPod
{
    public readonly PagedPodEnvelope Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationMessagePreviewPod
{
    public readonly int SenderType;
    public readonly long CreatedAtUnixMs;
    public readonly byte HasSenderName;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef SenderName;
    public readonly Utf8SliceRef BodyPreview;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationListItemPod
{
    public readonly long ConversationId;
    public readonly int Status;
    public readonly int UnreadCount;
    public readonly long LastMessageAtUnixMs;
    public readonly long UpdatedAtUnixMs;
    public readonly byte IsSystemSource;
    public readonly byte CanReply;
    public readonly byte HasLastMessage;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef Subject;
    public readonly ConversationMessagePreviewPod LastMessage;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationMessagePod
{
    public readonly long MessageId;
    public readonly long ConversationId;
    public readonly int SenderType;
    public readonly long CreatedAtUnixMs;
    public readonly byte HasSenderName;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef SenderName;
    public readonly Utf8SliceRef Body;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationDetailPod
{
    public readonly long ConversationId;
    public readonly int Status;
    public readonly int UnreadCount;
    public readonly long LastMessageAtUnixMs;
    public readonly byte IsSystemSource;
    public readonly byte CanReply;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Subject;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationCreateRequestPod
{
    public readonly Utf8SliceRef Subject;
    public readonly Utf8SliceRef Body;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationStatusRequestPod
{
    public readonly int Status;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SystemMessageRequestPod
{
    public readonly long TargetAccountId;
    public readonly byte HasTargetAccountId;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly int Reserved2;
    public readonly Utf8SliceRef Subject;
    public readonly Utf8SliceRef Body;
}
