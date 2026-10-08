using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentItem</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentItemPod
{
    public readonly long Id;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UserComment</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserCommentPod
{
    public readonly long Id;
    public readonly int ArticleId;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
    public readonly Utf8Fixed256 ArticleTitle;
    public readonly long RootId;
    public readonly int ModerationStatus;
    public readonly byte IsPubliclyVisible;
    public readonly byte Reserved0;
    public readonly byte Reserved1;
    public readonly byte Reserved2;
    public readonly Utf8Fixed32 VisibilityState;
    public readonly Utf8Fixed64 VisibilityReasonCode;
    public readonly Utf8Fixed64 ModerationStatusLabel;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentPolicyUpdateRequest</c> wire contract.
/// </summary>
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
    public readonly byte HasCommentMaxChars;
    public readonly byte HasCommentMaxUtf8Bytes;
    public readonly int CommentMaxChars;
    public readonly int CommentMaxUtf8Bytes;
    public readonly Utf8SliceRef SupportedDisplayLanguages;
}

/// <summary>
/// Defines the final moderation state returned after comment creation and any synchronous model disposition.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentCreateResultPod
{
    public readonly long CommentId;
    public readonly long RootId;
    public readonly long ParentId;
    public readonly long CreatedAtUnixMs;
    public readonly int ModerationStatus;
    public readonly byte VisibilityState;
    public readonly byte IsPubliclyVisible;
    public readonly byte IdempotencyReplay;
    public readonly byte HasParentId;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>BlindCredentialIssuerMetadata</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct BlindCredentialIssuerMetadataPod
{
    public readonly long CredentialEpoch;
    public readonly long ExpiresAtUnixMs;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort ModulusBytes;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef SchemeId;
    public readonly Utf8SliceRef IssuerPublicKeyId;
    public readonly Utf8SliceRef IssuerPublicKeyHash;
    public readonly Utf8SliceRef SubjectPublicKeyInfo;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>BlindCredentialIssueRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct BlindCredentialIssueRequestPod
{
    public readonly long CredentialEpoch;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef SchemeId;
    public readonly Utf8SliceRef IssuerPublicKeyId;
    public readonly Utf8SliceRef BlindedMessage;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>BlindCredentialIssueResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct BlindCredentialIssueResponsePod
{
    public readonly long CredentialEpoch;
    public readonly long ExpiresAtUnixMs;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef SchemeId;
    public readonly Utf8SliceRef IssuerPublicKeyId;
    public readonly Utf8SliceRef BlindSignature;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousCredentialRootSnapshot</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCredentialRootSnapshotPod
{
    public readonly long CredentialEpoch;
    public readonly long RootExpiresAtUnixMs;
    public readonly long RootGraceExpiresAtUnixMs;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly byte ZkAnonymousEnabled;
    public readonly byte VerifierConfigured;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef VerifyingKeyHash;
    public readonly Utf8SliceRef IssuerPublicKeyHash;
    public readonly Utf8SliceRef CredentialRoot;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef CircuitMetadata;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousCredentialRevocationArtifact</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCredentialRevocationArtifactPod
{
    public readonly long CredentialEpoch;
    public readonly long Version;
    public readonly long BaseVersion;
    public readonly long ExpiresAtUnixMs;
    public readonly uint EntryCount;
    public readonly ushort PathDepth;
    public readonly byte Kind;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef AlgorithmId;
    public readonly Utf8SliceRef IssuerPublicKeyHash;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef ContentHash;
    public readonly Utf8SliceRef Signature;
    public readonly Utf8SliceRef EntryHashes;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousCommentTicketRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCommentTicketRequestPod
{
    public readonly int ArticleId;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte IsEligible;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly byte MayComment;
    public readonly byte RequiresModeration;
    public readonly Utf8SliceRef ActionContext;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef VerifyingKeyHash;
    public readonly Utf8SliceRef NullifierHash;
    public readonly Utf8SliceRef CredentialRoot;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef RateClass;
    public readonly Utf8SliceRef Groth16Proof;
    public readonly Utf8SliceRef PublicInputs;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousCommentTicketResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCommentTicketResponsePod
{
    public readonly long TicketExpiresAtUnixMs;
    public readonly byte RequiresModeration;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef RateClass;
    public readonly Utf8SliceRef Ticket;
    public readonly Utf8SliceRef ModerationSubjectHash;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousCommentCreateRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCommentCreateRequestPod
{
    public readonly int ArticleId;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte Reserved0;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly Utf8SliceRef AnonymousScope;
    public readonly Utf8SliceRef DisplayLanguage;
    public readonly Utf8SliceRef Ticket;
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AnonymousPrivacyStateSnapshot</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousPrivacyStateSnapshotPod
{
    public readonly long CredentialEpoch;
    public readonly long RootExpiresAtUnixMs;
    public readonly long TicketExpiresAtUnixMs;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly byte HasActiveCredential;
    public readonly byte CanIssueCredential;
    public readonly byte CanSubmitAnonymousComment;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef VerifyingKeyHash;
    public readonly Utf8SliceRef CredentialStatus;
    public readonly Utf8SliceRef CredentialLevel;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentAuthorView</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentAuthorViewPod
{
    public readonly byte Mode;
    public readonly byte ReservedPrivacyClass;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef DisplayName;
    public readonly Utf8SliceRef DisplayLanguage;
    public readonly Utf8SliceRef Badge;
    public readonly Utf8SliceRef ScopeLabel;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentListResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentListResponsePod
{
    public readonly CursorPodEnvelope Envelope;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentThreadItem</c> wire contract.
/// </summary>
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
    public readonly Utf8SliceRef Content;
    public readonly int ReplyCount;
    public readonly byte HasMoreReplies;
    public readonly byte PreviewReplyCount;
    public readonly ushort Reserved2;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentReplyPreviewItem</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentReplyPreviewItemPod
{
    public readonly long Id;
    public readonly byte IsDeleted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentReplyItem</c> wire contract.
/// </summary>
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
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentThreadCursor</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentThreadCursorPod
{
    public readonly CursorPodEnvelope Envelope;
    public readonly int PreviewCount;
    public readonly int Reserved;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CommentReplyCursor</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentReplyCursorPod
{
    public readonly CursorPodEnvelope Envelope;
    public readonly long RootId;
    public readonly int Reserved;
}

/// <summary>
/// Defines one fixed-layout node in the recursive comment-tree wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentTreeNodePod
{
    public readonly long Id;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly int Depth;
    public readonly int ChildCount;
    public readonly byte IsDeleted;
    public readonly byte HasMoreChildren;
    public readonly ushort Reserved;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed header for a direct-child cursor page.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentChildCursorPod
{
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long NextCursor;
    public readonly int Count;
    public readonly byte HasMore;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

/// <summary>
/// Defines the fixed header for a privacy-preserving permalink context.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPermalinkContextPod
{
    public readonly long TargetId;
    public readonly long RootId;
    public readonly int AncestorCount;
    public readonly int SiblingCount;
    public readonly byte Status;
    public readonly byte HasTarget;
    public readonly byte HasPreviousSiblings;
    public readonly byte HasNextSiblings;
    public readonly int Reserved;
}
