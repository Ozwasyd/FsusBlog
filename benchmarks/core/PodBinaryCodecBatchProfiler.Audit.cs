using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

internal static partial class PodBinaryCodecBatchProfiler
{
    private static IReadOnlyList<AuditMeasurement> MeasureAuditScope(
        int iterations,
        int warmupIterations,
        int roundCount)
    {
        IReadOnlyList<AuditCase> cases = BuildAuditCases();
        var results = new List<AuditMeasurement>(cases.Count);
        foreach (AuditCase auditCase in cases)
        {
            byte[] output = auditCase.Encode();
            var rounds = new List<ProfileMeasurement>(roundCount);
            for (int round = 0; round < roundCount; round++)
            {
                rounds.Add(ProfilerSupport.Measure(
                    iterations,
                    warmupIterations,
                    () => Consume(auditCase.Encode())));
            }

            ProfileAggregate aggregate = ProfilerSupport.Aggregate(rounds);
            object evidence = new
            {
                codec = auditCase.Codec,
                scenario = auditCase.Scenario,
                itemCount = auditCase.ItemCount,
                outputBytes = output.Length,
                allocatedBytesPerFrame = aggregate.AllocatedBytesPerIteration,
                allocatedBytesPerItem = auditCase.ItemCount == 0
                    ? aggregate.AllocatedBytesPerIteration
                    : aggregate.AllocatedBytesPerIteration / auditCase.ItemCount,
                managedTemporaryCollectionCount = auditCase.ManagedTemporaryCollectionCount,
                capacityPolicy = auditCase.CapacityPolicy,
                copyBytes = auditCase.CopyBytes,
                measured = ProfilerSupport.ToEvidence(aggregate, rounds),
                encodeFrequency = FrequencyEvidence(),
                decision = "keep-current-baseline-only",
                decisionReason = auditCase.DecisionReason
            };
            results.Add(new AuditMeasurement(
                aggregate.AllocatedBytesPerIteration,
                aggregate.P95Ms,
                evidence));
        }

        return results;
    }

    private static IReadOnlyList<AuditCase> BuildAuditCases()
    {
        CoreCursorResult<CommentQueryCoreModel> commentShort = BuildCommentCursor(40, "short comment");
        CoreCursorResult<CommentQueryCoreModel> commentLong = BuildCommentCursor(40, new string('文', 2_048));
        CoreCursorResult<UserCommentCoreModel> userComments = BuildUserCommentCursor(40, new string('u', 512));
        CursorResponse<CommentReplyItemDto> replies = BuildCommentReplyCursor(40, new string('回', 512));
        CursorResponse<CommentThreadItemDto> threads = BuildCommentThreadCursor(20, 3);
        ConversationDetailResponse conversation = BuildConversationDetail(64, new string('m', 512));
        PageResponse<ConversationListItemResponse> conversationList = BuildConversationList(50);
        SiteStatsCoreModel stats = BuildSiteStats(10, 20, 8);
        IReadOnlyList<CategoryListItemResponse> categories = Enumerable.Range(1, 32)
            .Select(index => new CategoryListItemResponse
            {
                Id = index,
                Name = $"分类-{index}",
                ArticleCount = index * 3
            })
            .ToArray();
        IReadOnlyList<TagWithCountDto> tags = Enumerable.Range(1, 100)
            .Select(index => new TagWithCountDto(index, $"标签-{index}", index * 5))
            .ToArray();

        return
        [
            new AuditCase(
                "CommentCursor",
                "40-items-short-repeated-author",
                40,
                80,
                "per-item projector payload and author payload",
                commentShort.Data.Sum(static item => Utf8Bytes(item.Content)),
                () => PodBinaryCodec.EncodeCommentCursor(commentShort),
                "per-item payload construction is real, but no candidate-specific threshold evidence was produced in this narrow change"),
            new AuditCase(
                "CommentCursor",
                "40-items-long-repeated-author",
                40,
                80,
                "per-item projector payload and author payload",
                commentLong.Data.Sum(static item => Utf8Bytes(item.Content)),
                () => PodBinaryCodec.EncodeCommentCursor(commentLong),
                "author repetition suggests a future candidate, but wire-preserving interning requires a separate measured design"),
            new AuditCase(
                "UserCommentCursor",
                "40-items-medium-repeated-author-title",
                40,
                80,
                "per-item projector payload and author payload",
                userComments.Data.Sum(static item => Utf8Bytes(item.Content) + Utf8Bytes(item.ArticleTitle)),
                () => PodBinaryCodec.EncodeUserCommentCursor(userComments),
                "user cursor has richer validation and payload boundaries; it is deferred until a dedicated differential candidate exists"),
            new AuditCase(
                "CommentReplyCursor",
                "40-items-medium-repeated-authors",
                40,
                80,
                "per-item projector payload and author payload",
                replies.Data.Sum(static item => Utf8Bytes(item.Content)),
                () => PodBinaryCodec.EncodeCommentReplyCursor(1, replies),
                "reply hierarchy and author boundaries are kept unchanged without candidate evidence"),
            new AuditCase(
                "CommentThreadCursor",
                "20-roots-three-previews",
                80,
                160,
                "per-root and per-preview projector payloads",
                threads.Data.Sum(static item =>
                    Utf8Bytes(item.Content)
                    + item.RepliesPreview.Sum(static reply => Utf8Bytes(reply.Content))),
                () => PodBinaryCodec.EncodeCommentThreadCursor(threads),
                "root/preview structure is retained pending a dedicated packed-buffer candidate"),
            new AuditCase(
                "ConversationDetail",
                "64-messages-medium-repeated-sender",
                64,
                1,
                "single ArrayBufferWriter payload",
                conversation.Messages.Sum(static item => Utf8Bytes(item.Body)),
                () => PodBinaryCodec.EncodeConversationDetail(conversation),
                "already uses one growable payload and direct POD writes; List removal alone is not an applicable claim"),
            new AuditCase(
                "ConversationList",
                "50-items-preview",
                50,
                1,
                "single ArrayBufferWriter payload",
                conversationList.Items.Sum(static item =>
                    Utf8Bytes(item.Subject)
                    + Utf8Bytes(item.LastMessage?.BodyPreview)),
                () => PodBinaryCodec.EncodeConversationList(conversationList),
                "already uses one payload writer and direct records; retained after audit"),
            new AuditCase(
                "SiteStats",
                "10-popular-20-comments-8-regions",
                38,
                4,
                "fixed 1024-byte blob List plus three metadata Lists",
                0,
                () => PodBinaryCodec.EncodeSiteStats(stats),
                "lower-frequency admin stats remains a separate candidate; this issue avoids mechanically rewriting all codecs"),
            new AuditCase(
                "CategoryList",
                "32-categories",
                32,
                2,
                "heuristic blob List plus exact name-slice List",
                categories.Sum(static item => Utf8Bytes(item.Name)),
                () => PodBinaryCodec.EncodeCategoryList(categories),
                "small bounded taxonomy list is below the selected ArticlePage/Detail priority"),
            new AuditCase(
                "TagWithCountList",
                "100-tags",
                100,
                2,
                "heuristic blob List plus exact name-slice List",
                tags.Sum(static item => Utf8Bytes(item.Name)),
                () => PodBinaryCodec.EncodeTagWithCountList(tags),
                "taxonomy remains unchanged until a dedicated candidate proves a policy win")
        ];
    }

    private static CoreCursorResult<CommentQueryCoreModel> BuildCommentCursor(int count, string content)
    {
        var author = new CommentAuthorViewDto("public", "Repeated Author", "zh-CN", "member", "public");
        CommentQueryCoreModel[] items = Enumerable.Range(1, count)
            .Select(index => new CommentQueryCoreModel(
                default,
                index,
                $"{content}-{index}",
                DateTime.UnixEpoch.AddMinutes(index),
                author))
            .ToArray();
        return new CoreCursorResult<CommentQueryCoreModel>(items, count, true);
    }

    private static CoreCursorResult<UserCommentCoreModel> BuildUserCommentCursor(int count, string content)
    {
        var author = new CommentAuthorViewDto("public", "Repeated Author", "zh-CN", "member", "public");
        var replyTo = new CommentAuthorViewDto("public", "Repeated Reply", "zh-CN", null, "public");
        UserCommentCoreModel[] items = Enumerable.Range(1, count)
            .Select(index => new UserCommentCoreModel(
                default,
                index,
                $"{content}-{index}",
                DateTime.UnixEpoch.AddMinutes(index),
                42,
                "Repeated Article Title",
                index % 2 == 0 ? 1 : null,
                author,
                index % 2 == 0 ? replyTo : null,
                2,
                "approved",
                "public",
                "none",
                true))
            .ToArray();
        return new CoreCursorResult<UserCommentCoreModel>(items, count, true);
    }

    private static CursorResponse<CommentReplyItemDto> BuildCommentReplyCursor(int count, string content)
    {
        var author = new CommentAuthorViewDto("public", "Repeated Author", "zh-CN", "member", "public");
        var replyTo = new CommentAuthorViewDto("public", "Repeated Reply", "zh-CN", null, "public");
        return new CursorResponse<CommentReplyItemDto>
        {
            Data = Enumerable.Range(1, count)
                .Select(index => new CommentReplyItemDto(
                    index.ToString(),
                    $"{content}-{index}",
                    DateTime.UnixEpoch.AddMinutes(index),
                    author,
                    replyTo,
                    index == 1 ? null : (index - 1).ToString(),
                    "1",
                    index == 1 ? null : (index - 1).ToString(),
                    1,
                    false))
                .ToList(),
            NextCursor = count.ToString(),
            HasMore = true
        };
    }

    private static CursorResponse<CommentThreadItemDto> BuildCommentThreadCursor(int rootCount, int previewCount)
    {
        var author = new CommentAuthorViewDto("public", "Repeated Author", "zh-CN", "member", "public");
        return new CursorResponse<CommentThreadItemDto>
        {
            Data = Enumerable.Range(1, rootCount)
                .Select(index => new CommentThreadItemDto(
                    index.ToString(),
                    $"root-content-{index}",
                    DateTime.UnixEpoch.AddMinutes(index),
                    author,
                    index.ToString(),
                    false,
                    previewCount,
                    true,
                    Enumerable.Range(1, previewCount)
                        .Select(preview => new CommentReplyPreviewItemDto(
                            $"{index}{preview}",
                            $"preview-content-{preview}",
                            DateTime.UnixEpoch.AddMinutes(index + preview),
                            author,
                            author,
                            false))
                        .ToList()))
                .ToList(),
            NextCursor = rootCount.ToString(),
            HasMore = true
        };
    }

    private static ConversationDetailResponse BuildConversationDetail(int count, string body)
        => new()
        {
            ConversationId = "42",
            Subject = "Repeated support subject",
            Status = ConversationStatusValue.Open,
            CanReply = true,
            UnreadCount = count / 2,
            LastMessageAt = DateTime.UnixEpoch.AddHours(1),
            Messages = Enumerable.Range(1, count)
                .Select(index => new ConversationMessageResponse
                {
                    MessageId = index.ToString(),
                    ConversationId = "42",
                    SenderType = index % 2 == 0 ? ConversationSenderValue.Admin : ConversationSenderValue.Account,
                    SenderName = "Repeated Sender",
                    Body = $"{body}-{index}",
                    CreatedAt = DateTime.UnixEpoch.AddMinutes(index)
                })
                .ToList()
        };

    private static PageResponse<ConversationListItemResponse> BuildConversationList(int count)
        => new()
        {
            Total = count,
            Items = Enumerable.Range(1, count)
                .Select(index => new ConversationListItemResponse
                {
                    ConversationId = index.ToString(),
                    Subject = $"Repeated subject {index}",
                    Status = ConversationStatusValue.Open,
                    CanReply = true,
                    UnreadCount = index % 4,
                    LastMessageAt = DateTime.UnixEpoch.AddMinutes(index),
                    UpdatedAt = DateTime.UnixEpoch.AddMinutes(index + 1),
                    LastMessage = new ConversationMessagePreviewResponse
                    {
                        SenderType = ConversationSenderValue.Admin,
                        SenderName = "Repeated Sender",
                        BodyPreview = $"Preview {index}",
                        CreatedAt = DateTime.UnixEpoch.AddMinutes(index)
                    }
                })
                .ToList()
        };

    private static SiteStatsCoreModel BuildSiteStats(int popularCount, int recentCount, int regionCount)
    {
        PopularArticleCoreModel[] popular = Enumerable.Range(1, popularCount)
            .Select(index =>
            {
                string title = $"Popular article {index}";
                return new PopularArticleCoreModel(
                    PodProjector.ProjectPopularArticle(index, title, index * 100),
                    index,
                    title,
                    index * 100);
            })
            .ToArray();
        RecentCommentCoreModel[] recent = Enumerable.Range(1, recentCount)
            .Select(index =>
            {
                DateTime created = DateTime.UnixEpoch.AddMinutes(index);
                string content = $"Recent comment content {index}";
                RecentCommentPod pod = PodProjector.ProjectRecentComment(
                    created,
                    "Author",
                    "public",
                    "member",
                    "public",
                    content,
                    out _);
                return new RecentCommentCoreModel(
                    pod,
                    "Author",
                    "public",
                    "member",
                    "public",
                    content,
                    created);
            })
            .ToArray();
        RegionDistributionCoreModel[] regions = Enumerable.Range(1, regionCount)
            .Select(index =>
            {
                string region = $"Region-{index}";
                return new RegionDistributionCoreModel(
                    PodProjector.ProjectRegionDistribution(region, index * 7),
                    region,
                    index * 7);
            })
            .ToArray();
        SiteStatsPod pod = PodProjector.ProjectSiteStats(
            100,
            200,
            10,
            10_000,
            6_000,
            4_000,
            6_000,
            4_000,
            popular.Length,
            recent.Length,
            regions.Length);
        return new SiteStatsCoreModel(
            pod,
            100,
            200,
            10,
            10_000,
            6_000,
            4_000,
            6_000,
            4_000,
            popular,
            recent,
            regions);
    }

    private sealed record AuditCase(
        string Codec,
        string Scenario,
        int ItemCount,
        int ManagedTemporaryCollectionCount,
        string CapacityPolicy,
        int CopyBytes,
        Func<byte[]> Encode,
        string DecisionReason);
}
