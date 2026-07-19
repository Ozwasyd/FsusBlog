using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MessageInbox</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentPush</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPushPod
{
    public readonly long Id;
    public readonly long CreateTimeUnixMs;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly int Depth;
    public readonly byte IsDeleted;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte HasReplyToAuthor;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Content;
    public readonly Utf8SliceRef Author;
    public readonly Utf8SliceRef ReplyToAuthor;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentAddedNotify</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentAddedNotifyPod
{
    public readonly int ArticleId;
    public readonly int Reserved;
    public readonly long TimeUnixMs;
    public readonly CommentPushPod Comment;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>GlobalNoticePayload</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct GlobalNoticePayloadPod
{
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed64 Id;
    public readonly Utf8Fixed256 Title;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MessageRevokedPayload</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MessageRevokedPayloadPod
{
    public readonly Utf8Fixed64 MessageId;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AccountStatusPayload</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AccountStatusPayloadPod
{
    public readonly int Status;
    public readonly long TimeUnixMs;
    public readonly Utf8SliceRef Reason;
    public readonly byte HasReason;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>NoticePayload</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct NoticePayloadPod
{
    public readonly int UnreadCount;
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed256 Title;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentRemovedPayload</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentRemovedPayloadPod
{
    public readonly int ArticleId;
    public readonly int Reserved;
    public readonly long TimeUnixMs;
    public readonly Utf8Fixed64 CommentId;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MessageInboxList</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MessageInboxListPod
{
    public readonly PagedPodEnvelope Envelope;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationMessagePreview</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationListItem</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the admin-only conversation list item projection.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AdminConversationListItemPod
{
    public readonly ConversationListItemPod Conversation;
    public readonly long CounterpartyAccountId;
    public readonly int CounterpartyAccountStatus;
    public readonly int Reserved0;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationMessage</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationDetail</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout v2 binary representation used by the
/// <c>ConversationDetail</c> wire contract with an explicit account read snapshot.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationDetailV2Pod
{
    public readonly long ConversationId;
    public readonly int Status;
    public readonly int UnreadCount;
    public readonly long LastMessageAtUnixMs;
    public readonly long ReadSnapshotMessageId;
    public readonly byte IsSystemSource;
    public readonly byte CanReply;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Subject;
}

/// <summary>
/// Defines the paged conversation detail header. The previous cursor is the
/// oldest message id in the current page and is returned only when older rows exist.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationDetailV3Pod
{
    public readonly long ConversationId;
    public readonly int Status;
    public readonly int UnreadCount;
    public readonly long LastMessageAtUnixMs;
    public readonly long ReadSnapshotMessageId;
    public readonly long PreviousCursorMessageId;
    public readonly byte IsSystemSource;
    public readonly byte CanReply;
    public readonly byte HasOlder;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef Subject;
}

/// <summary>
/// Defines the admin-only paged conversation detail projection.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AdminConversationDetailPod
{
    public readonly ConversationDetailV3Pod Conversation;
    public readonly long CounterpartyAccountId;
    public readonly int CounterpartyAccountStatus;
    public readonly int Reserved0;
}

/// <summary>
/// Defines an account mark-read request bound to a message returned by detail.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationReadRequestPod
{
    public readonly long ReadThroughMessageId;
}

/// <summary>
/// Defines an account reply request with an explicit read-through position.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AccountConversationReplyRequestPod
{
    public readonly long ReadThroughMessageId;
    public readonly Utf8SliceRef Body;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationCreateRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationCreateRequestPod
{
    public readonly Utf8SliceRef Subject;
    public readonly Utf8SliceRef Body;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>ConversationStatusRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ConversationStatusRequestPod
{
    public readonly int Status;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>SystemMessageRequest</c> wire contract.
/// </summary>
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
