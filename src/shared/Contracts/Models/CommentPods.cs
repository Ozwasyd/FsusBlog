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
    public readonly int ModerationStatus;
    public readonly byte IsPubliclyVisible;
    public readonly byte Reserved0;
    public readonly byte Reserved1;
    public readonly byte Reserved2;
    public readonly Utf8Fixed32 VisibilityState;
    public readonly Utf8Fixed64 VisibilityReasonCode;
    public readonly Utf8Fixed64 ModerationStatusLabel;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentPolicySnapshotPod
{
    public readonly byte AnonymousCommentsEnabled;
    public readonly byte PublicCommentsEnabled;
    public readonly byte ZkAnonymousEnabled;
    public readonly byte DefaultAuthorMode;
    public readonly byte ZkProdEnabled;
    public readonly byte ZkProdNativeVerifierConfigured;
    public readonly byte ZkProdTrustedSetupVerified;
    public readonly byte ZkProdCredentialRequired;
    public readonly byte ZkProdCredentialRootReady;
    public readonly Utf8SliceRef SupportedDisplayLanguages;
    public readonly Utf8SliceRef ZkProdUnavailableReason;
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
public readonly struct AnonymousCredentialIssueRequestPod
{
    public readonly long CredentialEpoch;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef CredentialRequest;
    public readonly Utf8SliceRef ClientNonce;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCredentialIssueResponsePod
{
    public readonly long CredentialEpoch;
    public readonly long ExpiresAtUnixMs;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef IssuerPublicKeyId;
    public readonly Utf8SliceRef IssuerSignature;
}

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

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCredentialRevocationWitnessRequestPod
{
    public readonly long CredentialEpoch;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef IssuerPublicKeyHash;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef RevocationHandleHash;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCredentialRevocationWitnessResponsePod
{
    public readonly long CredentialEpoch;
    public readonly ushort PathDepth;
    public readonly ushort Reserved0;
    public readonly uint SiblingHashCount;
    public readonly Utf8SliceRef AlgorithmId;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef IssuerPublicKeyHash;
    public readonly Utf8SliceRef RevocationHandleHash;
    public readonly Utf8SliceRef LeafKey;
    public readonly Utf8SliceRef WitnessHash;
    public readonly Utf8SliceRef SiblingHashes;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCommentTicketRequestPod
{
    public readonly int ArticleId;
    public readonly byte HasParentId;
    public readonly byte HasRootId;
    public readonly byte HasReplyToCommentId;
    public readonly byte Reserved0;
    public readonly long ParentId;
    public readonly long RootId;
    public readonly long ReplyToCommentId;
    public readonly long CredentialEpoch;
    public readonly uint CircuitNumericId;
    public readonly ushort PublicInputLayoutVersion;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef ActionContext;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef CircuitId;
    public readonly Utf8SliceRef VerifyingKeyHash;
    public readonly Utf8SliceRef NullifierHash;
    public readonly Utf8SliceRef CredentialRoot;
    public readonly Utf8SliceRef RevocationRoot;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef ReputationBucket;
    public readonly Utf8SliceRef Groth16Proof;
    public readonly Utf8SliceRef PublicInputs;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AnonymousCommentTicketResponsePod
{
    public readonly long CredentialEpoch;
    public readonly long TicketExpiresAtUnixMs;
    public readonly Utf8SliceRef CredentialLevel;
    public readonly Utf8SliceRef Ticket;
    public readonly Utf8SliceRef ModerationSubjectHash;
}

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
    public readonly long CredentialEpoch;
    public readonly Utf8SliceRef AnonymousScope;
    public readonly Utf8SliceRef DisplayLanguage;
    public readonly Utf8SliceRef Ticket;
    public readonly Utf8SliceRef Content;
}

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
