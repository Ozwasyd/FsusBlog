using System.Runtime.CompilerServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Validation;

public static class PodContractValidation
{
    public static bool AreAllPodModelsReferenceFree()
    {
        return IsReferenceFree<Utf8Fixed32>()
            && IsReferenceFree<Utf8Fixed64>()
            && IsReferenceFree<Utf8Fixed128>()
            && IsReferenceFree<Utf8Fixed256>()
            && IsReferenceFree<Utf8Fixed512>()
            && IsReferenceFree<Utf8SliceRef>()
            && IsReferenceFree<PodEnvelopeHeader>()
            && IsReferenceFree<PageEnvelope>()
            && IsReferenceFree<CursorEnvelope>()
            && IsReferenceFree<PagedPodEnvelope>()
            && IsReferenceFree<CursorPodEnvelope>()
            && IsReferenceFree<ArticleCategoryViewPod>()
            && IsReferenceFree<TagPod>()
            && IsReferenceFree<TagWithCountPod>()
            && IsReferenceFree<CategoryPod>()
            && IsReferenceFree<ArticleListItemPod>()
            && IsReferenceFree<ArticleDetailPod>()
            && IsReferenceFree<ArticleNoticePod>()
            && IsReferenceFree<ArticleMutationResponsePod>()
            && IsReferenceFree<TrashClearResponsePod>()
            && IsReferenceFree<ArticleListPagePod>()
            && IsReferenceFree<ArticleHotListPod>()
            && IsReferenceFree<ArticleTagListPod>()
            && IsReferenceFree<CommentItemPod>()
            && IsReferenceFree<UserCommentPod>()
            && IsReferenceFree<CommentListResponsePod>()
            && IsReferenceFree<MessageInboxPod>()
            && IsReferenceFree<CommentPushPod>()
            && IsReferenceFree<CommentAddedNotifyPod>()
            && IsReferenceFree<GlobalNoticePayloadPod>()
            && IsReferenceFree<MessageRevokedPayloadPod>()
            && IsReferenceFree<UserStatusPayloadPod>()
            && IsReferenceFree<NoticePayloadPod>()
            && IsReferenceFree<CommentRemovedPayloadPod>()
            && IsReferenceFree<MessageInboxListPod>()
            && IsReferenceFree<TokenResponsePod>()
            && IsReferenceFree<LoginResponsePod>()
            && IsReferenceFree<UserListItemPod>()
            && IsReferenceFree<UserListPagePod>()
            && IsReferenceFree<SeoConfigPod>()
            && IsReferenceFree<PageContentPod>()
            && IsReferenceFree<PopularArticlePod>()
            && IsReferenceFree<RecentCommentPod>()
            && IsReferenceFree<RegionDistributionPod>()
            && IsReferenceFree<SiteStatsPod>()
            && IsReferenceFree<FileUploadOutputPod>()
            && IsReferenceFree<PowChallengePod>();
    }

    public static int SizeOf<T>() where T : unmanaged => Unsafe.SizeOf<T>();

    private static bool IsReferenceFree<T>() => !RuntimeHelpers.IsReferenceOrContainsReferences<T>();
}
