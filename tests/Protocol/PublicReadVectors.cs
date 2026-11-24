internal static class PublicReadVectors
{
    internal static void Run(string fixtures)
    {
        RunArticleHot(fixtures);
        RunPublicArticlesAndRelated(fixtures);
        RunPublishedMedia();
        RunCommentRead(fixtures);
        RunInbox(fixtures);
    }

    private static void RunArticleHot(string fixtures)
    {
        var frame = Hex(fixtures, "article-hot-v1.hex");
        ArticleHotItem[] expected = [new(42, 0, "雪 🐈"), new(7, int.MaxValue, ""), new(19, 9, "\uFEFFCafe\u0301")];
        Require((int)FrameType.ArticleHot == 3 && WireRoutes.PublicArticleHot == "/api/binary/article/hot/{size}.aeds" &&
            frame.AsSpan().SequenceEqual(ArticleHotWire.Encode(expected)) && expected.SequenceEqual(ArticleHotWire.Decode(frame)));
        var empty = Hex(fixtures, "article-hot-empty-v1.hex");
        Require(empty.AsSpan().SequenceEqual(ArticleHotWire.Encode([])) && ArticleHotWire.Decode(empty).Length == 0);

        var title = new string('界', 84) + "🐈";
        var maximum = Enumerable.Range(1, 100).Select(id => new ArticleHotItem(id, 0, title)).ToArray();
        Require(maximum.SequenceEqual(ArticleHotWire.Decode(ArticleHotWire.Encode(maximum))));
        RejectEach<ArticleHotItem[]>(
            [[.. maximum, new(101, 0, "")], [new(1, 0, title + "a")], [new(1, 0, "\uD800")],
             [new(1, -1, "")], [new(0, 0, "")], [new(1, 0, ""), new(1, 0, "")]],
            items => ArticleHotWire.Encode(items));

        var payload = Aeds.Decode(frame, FrameType.ArticleHot).ToArray();
        var rec = 8 + 17;
        RejectEach<(int at, int val)>(
            [(0, -1), (0, 101), (4, -1), (4, int.MaxValue), (rec, 0), (rec + 4, -1),
             (rec + 8, 1), (rec + 12, 257), (rec + 16, 42), (rec + 44, 0)],
            c => ArticleHotWire.Decode(Aeds.Encode(FrameType.ArticleHot, WithI32(payload, c.at, c.val))));
        RejectAll(
            () => ArticleHotWire.Decode(Aeds.Encode(FrameType.ArticleList, payload)),
            () => ArticleHotWire.DecodePayload(payload[..^1]),
            () => ArticleHotWire.DecodePayload([.. payload, 0]),
            () => ArticleHotWire.DecodePayload(WithByte(payload, 8, 0xff)));
    }

    private static void RunPublicArticlesAndRelated(string fixtures)
    {
        var article = new Article(42, 9_007_199_254_740_993, 9_007_199_254_741_001, 4, 2, "雪原 🐈", "第一行\nsecond line\n",
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_123),
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_001_234),
            DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345), "摘要");
        CheckHex(fixtures, "article-detail-ard5.hex", PublicArticles.EncodeDetail(article));
        CheckHex(fixtures, "article-list-cursor-v2.hex", PublicArticles.EncodeList([article], 2, "v2_Ab-1"));
        CheckHex(fixtures, "article-search-fas4.hex", PublicArticles.EncodeSearch([article], 2));
        RejectEach(
            [article with { Revision = 0 }, article with { PublicationNo = 0 },
             article with { Title = "padding\0title" }, article with { Title = new string('雪', 86) }],
            invalid => PublicArticles.EncodeDetail(invalid));

        static RelatedItem Item(int id, long ms, string title, string? summary, string reason) =>
            new(id, DateTimeOffset.FromUnixTimeMilliseconds(ms), title, summary, reason);
        CheckMultilineHex(fixtures, "article-related-reading-v1.hex", RelatedReadingWire.Encode(new(
            [Item(10, 1779019200000, "AEDS public reads", "Binary contract", "同分类"),
             Item(11, 1779105600000, "Hydration notes", null, "全文关键词")],
            Item(9, 1778932800000, "Previous article", "previous summary", "上一篇"),
            Item(12, 1779192000000, "Next article", null, "下一篇"))));
        var emptyRelated = Aeds.Decode(RelatedReadingWire.Encode(new([], null, null)), FrameType.ArticleRelatedReading);
        Require(emptyRelated.Length == 12 && !emptyRelated.ContainsAnyExcept((byte)0));
    }

    private static void RunPublishedMedia()
    {
        var key = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
        var asset = Guid.Parse("fedcba98-7654-3210-0123-456789abcdef");
        const long revision = 0x0102030405060708;
        var commandBytes = HexBytes("21000000080706050403020100112233445566778899aabbccddeeff01000000fedcba98765432100123456789abcdef");
        Equal(commandBytes, Aeds.Decode(Wire.EncodeArticlePublishImages(new(33, revision, key, [asset])), FrameType.ArticlePublishImages));
        var command = Wire.DecodeArticlePublishImages(Aeds.Encode(FrameType.ArticlePublishImages, commandBytes));
        Require(command.ArticleId == 33 && command.ExpectedRevision == revision && command.IdempotencyKey == key && command.AssetIds.SequenceEqual([asset]));

        const string digest = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        var image = new PublishedArticleImage(digest, 2, 1024, 1600, 900);
        var manifestBytes = HexBytes("21000000080706050403020101000000" + digest + "02000000000400004006000084030000");
        Equal(manifestBytes, Aeds.Decode(Wire.EncodePublicArticleMedia(new(33, revision, [image])), FrameType.PublicArticleMedia));
        var manifest = Wire.DecodePublicArticleMedia(Aeds.Encode(FrameType.PublicArticleMedia, manifestBytes));
        Require(manifest.ArticleId == 33 && manifest.Publication == revision && manifest.Images.SequenceEqual([image]));

        RejectAll(
            () => Wire.DecodeArticlePublishImages(Aeds.Encode(FrameType.ArticlePublishImages, commandBytes.AsSpan(0, 47))),
            () => Wire.EncodeArticlePublishImages(new(33, revision, key, [asset, asset])),
            () => Wire.DecodePublicArticleMedia(Aeds.Encode(FrameType.PublicArticleMedia, [.. manifestBytes, 0])),
            () => Wire.EncodePublicArticleMedia(new(33, revision, [image with { Width = 8192, Height = 8192 }])),
            () => Wire.EncodePublicArticleMedia(new(33, revision, [image, image])));
        Equal(WithI32(manifestBytes, 12, 0).AsSpan(0, 16), Aeds.Decode(Wire.EncodePublicArticleMedia(new(33, revision, [])), FrameType.PublicArticleMedia));
    }

    private static void RunCommentRead(string fixtures)
    {
        const long rootId = 9007199254740993;
        var publicAuthor = new CommentAuthor(CommentAuthorMode.Public, "Writer", "en");
        var anonymous = new CommentAuthor(CommentAuthorMode.ZkAnonymous, "匿名角色", "zh-CN", "some scope");
        var time = DateTimeOffset.FromUnixTimeMilliseconds(1700000000000);
        var root = new CommentNode(rootId, null, rootId, null, 0, 1, false, false, time, "Root fixture", publicAuthor, IsEdited: true);
        var reply = new CommentNode(rootId + 1, rootId, rootId, rootId, 1, 0, false, false, time, "Visible reply 独立", anonymous, publicAuthor);
        CheckHex(fixtures, "comment-root-current.hex", CommentReadWire.Roots([new(root, [reply])], null));
        CheckHex(fixtures, "comment-children-current.hex", CommentReadWire.Children(rootId, rootId, [reply], null));
        CheckHex(fixtures, "comment-context-current.hex", CommentReadWire.Context(reply, [root], []));
    }

    private static void RunInbox(string fixtures)
    {
        var time = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var item = new InboxListRecord(7, "Support", 1, 2, time, time.AddDays(1), true, true, new(1, time.AddDays(2), "Latest reply", "Admin"));
        CheckMultilineHex(fixtures, "conversation-list-frame.hex", InboxWire.EncodeList([item], 1));
        var message = new InboxMessageRecord(11, 7, 0, time.AddHours(1), "Message body", "Alice");
        CheckMultilineHex(fixtures, "conversation-message-frame.hex", InboxWire.EncodeMessage(message));
        var detail = new InboxDetailRecord(7, "Support", 0, 1, time, 11, false, true, [message]);
        CheckMultilineHex(fixtures, "conversation-detail-v2.hex", InboxWire.EncodeDetail(detail with { Replayed = true }, createResponse: true));
        CheckMultilineHex(fixtures, "conversation-detail-v3.hex", InboxWire.EncodeDetail(detail with { Previous = 11 }));

        var cursor = new InboxCursor(9_007_199_254_741_001, time, 7);
        var token = InboxWire.EncodeCursor(cursor);
        var cursorList = Aeds.Decode(InboxWire.EncodeList([item], 2, token), FrameType.ConversationList);
        Require(InboxWire.DecodeCursor(token) == cursor && BinaryPrimitives.ReadInt32LittleEndian(cursorList) == 0x4D534743 &&
            BinaryPrimitives.ReadInt32LittleEndian(cursorList[4..]) == 1 && cursorList[8] == 1 &&
            BinaryPrimitives.ReadInt32LittleEndian(cursorList[13..]) == 32 && BinaryPrimitives.ReadInt32LittleEndian(cursorList[17..]) == 2 &&
            cursorList[^56..^24].SequenceEqual(System.Text.Encoding.ASCII.GetBytes(token)));
        Reject(() => InboxWire.DecodeCursor(token + "="));

        var create = MultilineHex(fixtures, "conversation-create-request.hex");
        var reply = MultilineHex(fixtures, "conversation-reply-request.hex");
        Equal(create, InboxWire.EncodeCreate("申诉", "A café 🐈"));
        Equal(reply, InboxWire.EncodeReply(cursor.SnapshotMessageId, "A café 🐈"));
        Require(InboxWire.DecodeCreate(create) == ("申诉", "A café 🐈") && InboxWire.DecodeReply(reply) == (cursor.SnapshotMessageId, "A café 🐈") &&
            InboxWire.DecodeRead(MultilineHex(fixtures, "conversation-read-request.hex")) == cursor.SnapshotMessageId);

        RejectTruncations(create, span => InboxWire.DecodeCreate(span));
        var payload = Aeds.Decode(create, FrameType.ConversationCreateRequest).ToArray();
        RejectAll(
            () => InboxWire.DecodeCreate(Aeds.Encode(FrameType.ConversationCreateRequest, WithByte(payload, payload.Length - 1, 255))),
            () => InboxWire.DecodeCreate(Aeds.Encode(FrameType.ConversationCreateRequest, WithI32(payload, 0, int.MaxValue))),
            () => InboxWire.DecodeReply(Aeds.Encode(FrameType.AccountConversationReplyRequest, new byte[20])),
            () => InboxWire.DecodeRead(Aeds.Encode(FrameType.ConversationReadRequest, new byte[9])));
    }
}
