using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentItemPod
{
    public readonly long Id;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserCommentPod
{
    public readonly long Id;
    public readonly int ArticleId;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
    public readonly Utf8Fixed256 ArticleTitle;
    public readonly long RootId;
    public readonly Utf8Fixed64 ReplyToUserName;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentCreateRequestPod
{
    public readonly int ArticleId;
    public readonly int ReplyToUserId;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte HasReplyToUserId;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPolicySnapshotPod
{
    public readonly byte AnonymousCommentsEnabled;
    public readonly byte PublicCommentsEnabled;
    public readonly byte ZkAnonymousEnabled;
    public readonly byte DefaultAuthorMode;
    public readonly Utf8SliceRef SupportedDisplayLanguages;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPolicyUpdateRequestPod
{
    public readonly byte HasAnonymousCommentsEnabled;
    public readonly byte AnonymousCommentsEnabled;
    public readonly byte HasPublicCommentsEnabled;
    public readonly byte PublicCommentsEnabled;
    public readonly byte HasZkAnonymousEnabled;
    public readonly byte ZkAnonymousEnabled;
    public readonly byte HasDefaultAuthorMode;
    public readonly byte DefaultAuthorMode;
    public readonly Utf8SliceRef SupportedDisplayLanguages;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentCreateV2RequestPod
{
    public readonly int ArticleId;
    public readonly int ReplyToUserId;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte HasReplyToUserId;
    public readonly byte AuthorMode;
    public readonly byte PublicSendExplicitlySelected;
    public readonly ushort Reserved0;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly Utf8SliceRef AnonymousScope;
    public readonly Utf8SliceRef DisplayLanguage;
    public readonly Utf8SliceRef ProofToken;
    public readonly Utf8SliceRef ZkProof;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentAuthorViewPod
{
    public readonly byte Mode;
    public readonly byte CredentialLevel;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef DisplayName;
    public readonly Utf8SliceRef DisplayLanguage;
    public readonly Utf8SliceRef Badge;
    public readonly Utf8SliceRef ScopeLabel;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentListResponsePod
{
    public readonly CursorPodEnvelope Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentThreadItemPod
{
    public readonly long Id;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly int ReplyToUserId;
    public readonly long ReplyToCommentId;
    public readonly int Depth;
    public readonly byte IsDeleted;
    public readonly byte HasReplyToUserId;
    public readonly ushort Reserved;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8Fixed64 ReplyToUserName;
    public readonly Utf8SliceRef Content;
    public readonly int ReplyCount;
    public readonly byte HasMoreReplies;
    public readonly byte PreviewReplyCount;
    public readonly ushort Reserved2;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentReplyPreviewItemPod
{
    public readonly long Id;
    public readonly byte IsDeleted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8Fixed64 ReplyToUserName;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentReplyItemPod
{
    public readonly long Id;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly int ReplyToUserId;
    public readonly long ReplyToCommentId;
    public readonly int Depth;
    public readonly byte IsDeleted;
    public readonly byte HasReplyToUserId;
    public readonly ushort Reserved;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8Fixed64 ReplyToUserName;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentThreadCursorPod
{
    public readonly CursorPodEnvelope Envelope;
    public readonly int PreviewCount;
    public readonly int Reserved;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentReplyCursorPod
{
    public readonly CursorPodEnvelope Envelope;
    public readonly long RootId;
    public readonly int Reserved;
}
