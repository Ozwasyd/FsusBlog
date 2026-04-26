using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Validation;

public static class PodSizeCatalog
{
    public static readonly int Utf8Fixed32 = PodContractValidation.SizeOf<Utf8Fixed32>();
    public static readonly int Utf8Fixed64 = PodContractValidation.SizeOf<Utf8Fixed64>();
    public static readonly int Utf8Fixed128 = PodContractValidation.SizeOf<Utf8Fixed128>();
    public static readonly int Utf8Fixed256 = PodContractValidation.SizeOf<Utf8Fixed256>();
    public static readonly int Utf8Fixed512 = PodContractValidation.SizeOf<Utf8Fixed512>();
    public static readonly int Utf8SliceRef = PodContractValidation.SizeOf<Utf8SliceRef>();

    public static readonly int PodEnvelopeHeader = PodContractValidation.SizeOf<PodEnvelopeHeader>();
    public static readonly int PageEnvelope = PodContractValidation.SizeOf<PageEnvelope>();
    public static readonly int CursorEnvelope = PodContractValidation.SizeOf<CursorEnvelope>();
    public static readonly int PagedPodEnvelope = PodContractValidation.SizeOf<PagedPodEnvelope>();
    public static readonly int CursorPodEnvelope = PodContractValidation.SizeOf<CursorPodEnvelope>();

    public static readonly int ArticleListItemPod = PodContractValidation.SizeOf<ArticleListItemPod>();
    public static readonly int ArticleDetailPod = PodContractValidation.SizeOf<ArticleDetailPod>();
    public static readonly int TagPod = PodContractValidation.SizeOf<TagPod>();
    public static readonly int TagWithCountPod = PodContractValidation.SizeOf<TagWithCountPod>();
    public static readonly int CategoryPod = PodContractValidation.SizeOf<CategoryPod>();
    public static readonly int ArticleNoticePod = PodContractValidation.SizeOf<ArticleNoticePod>();
    public static readonly int ArticleMutationResponsePod = PodContractValidation.SizeOf<ArticleMutationResponsePod>();
    public static readonly int TrashClearResponsePod = PodContractValidation.SizeOf<TrashClearResponsePod>();

    public static readonly int CommentItemPod = PodContractValidation.SizeOf<CommentItemPod>();
    public static readonly int UserCommentPod = PodContractValidation.SizeOf<UserCommentPod>();
    public static readonly int CommentThreadItemPod = PodContractValidation.SizeOf<CommentThreadItemPod>();
    public static readonly int CommentReplyItemPod = PodContractValidation.SizeOf<CommentReplyItemPod>();
    public static readonly int CommentThreadCursorPod = PodContractValidation.SizeOf<CommentThreadCursorPod>();
    public static readonly int CommentReplyCursorPod = PodContractValidation.SizeOf<CommentReplyCursorPod>();

    public static readonly int MessageInboxPod = PodContractValidation.SizeOf<MessageInboxPod>();
    public static readonly int CommentPushPod = PodContractValidation.SizeOf<CommentPushPod>();
    public static readonly int CommentAddedNotifyPod = PodContractValidation.SizeOf<CommentAddedNotifyPod>();
    public static readonly int GlobalNoticePayloadPod = PodContractValidation.SizeOf<GlobalNoticePayloadPod>();
    public static readonly int MessageRevokedPayloadPod = PodContractValidation.SizeOf<MessageRevokedPayloadPod>();
    public static readonly int UserStatusPayloadPod = PodContractValidation.SizeOf<UserStatusPayloadPod>();
    public static readonly int NoticePayloadPod = PodContractValidation.SizeOf<NoticePayloadPod>();
    public static readonly int CommentRemovedPayloadPod = PodContractValidation.SizeOf<CommentRemovedPayloadPod>();

    public static readonly int TokenResponsePod = PodContractValidation.SizeOf<TokenResponsePod>();
    public static readonly int LoginResponsePod = PodContractValidation.SizeOf<LoginResponsePod>();
    public static readonly int UserListItemPod = PodContractValidation.SizeOf<UserListItemPod>();

    public static readonly int SeoConfigPod = PodContractValidation.SizeOf<SeoConfigPod>();
    public static readonly int PageContentPod = PodContractValidation.SizeOf<PageContentPod>();

    public static readonly int PopularArticlePod = PodContractValidation.SizeOf<PopularArticlePod>();
    public static readonly int RecentCommentPod = PodContractValidation.SizeOf<RecentCommentPod>();
    public static readonly int RegionDistributionPod = PodContractValidation.SizeOf<RegionDistributionPod>();
    public static readonly int SiteStatsPod = PodContractValidation.SizeOf<SiteStatsPod>();

    public static readonly int FileUploadOutputPod = PodContractValidation.SizeOf<FileUploadOutputPod>();
    public static readonly int PowChallengePod = PodContractValidation.SizeOf<PowChallengePod>();
}
