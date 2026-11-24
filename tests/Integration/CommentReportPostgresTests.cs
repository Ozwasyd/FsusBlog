namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task SignedInCommentReportsDeduplicateByAccountAndArticleWithoutChangingModeration()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (first, second) = await SeedBatchReplies(fixture, 0, ct);
        var articleOwner = Guid.NewGuid();
        await fixture.AdminPrincipalAsync(articleOwner, "other-report-article-owner", ct: ct);
        await fixture.Exec("""
            with other as (
                insert into public.article(owner_id,revision,title,body,deleted)
                values($1,1,'Other article','Other article',false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
                select id,1,'Other article','Other article',clock_timestamp() from other
            """, articleOwner);
        await PublishCommentArticle(fixture, 2);
        await fixture.Exec("""
            insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                values(2,1,1,0,1,false,'Other public comment',3,'Other display name','en',clock_timestamp());
            """);

        var submitted = new CommentReportRequest("spam", "First account explanation");
        var deliveries = await Task.WhenAll(Send(first, 1, 1, submitted), Send(first, 1, 1, submitted));
        var initial = Assert.Single(deliveries, reply => !reply.Duplicate);
        Assert.Equal(initial.ReportId, Assert.Single(deliveries, reply => reply.Duplicate).ReportId);
        Assert.InRange(initial.ReportId, 1, Wire.MaxCommentReportId);
        Assert.Equal(new CommentReportResult(true, "comment_report_duplicate", initial.ReportId, true),
            await Send(first, 1, 1, new("privacy", "A later report cannot replace the original.")));
        var differentAccount = await Send(second, 1, 1, new("privacy", null));
        var differentArticle = await Send(first, 2, 1, submitted);
        Assert.False(differentAccount.Duplicate);
        Assert.False(differentArticle.Duplicate);
        Assert.Equal(3, new HashSet<long> { initial.ReportId, differentAccount.ReportId, differentArticle.ReportId }.Count);
        await Denied(Rejection.NotFound, () => Send(first, 2, 2, submitted));

        foreach (var (blockSql, restoreSql) in new[]
        {
            ("insert into public.comment_blocked_region values(1,1,'ZZ')", "delete from public.comment_blocked_region where article_id=1 and comment_id=1"),
            ("update public.comment set moderation_status=0 where article_id=1 and id=1", "update public.comment set moderation_status=1 where article_id=1 and id=1"),
            ("update public.comment set deleted=true where article_id=1 and id=1", "update public.comment set deleted=false where article_id=1 and id=1"),
            ("update public.article set published_revision=null where id=1", "update public.article set published_revision=1 where id=1"),
        })
        {
            await fixture.Exec(blockSql);
            await Denied(Rejection.NotFound, () => Send(first, 1, 1, submitted));
            await fixture.Exec(restoreSql);
        }

        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.comment_report)=3
                and exists(select from public.comment_report r join public.article_publication p using(article_id,publication_id)
                    where r.id=$1 and r.reporter_id=$2 and r.article_id=1 and r.comment_id=1
                    and r.reason_code='spam' and r.detail='First account explanation')
                and exists(select from public.comment where article_id=1 and id=1 and moderation_status=1 and moderation_version=2
                    and body='Awaiting review' and not deleted and edited_at is null)
                and not exists(select from public.admin_comment_moderation)
                and not exists(select from public.comment_moderation_log)
                and not exists(select from public.comment_author_edit_outbox)
                and not exists(select from public.inbox_event)
            """, initial.ReportId, first));

        Task<CommentReportResult> Send(Guid account, int article, long comment, CommentReportRequest input) =>
            fixture.InTx((connection, tx) => CommentReports.Submit(connection, tx, account, article, comment, input, ct), ct);
    }

    [Fact]
    public void CommentReportFramesKeepV1JsonShapeAndNormalizeAccountReportInputs()
    {
        Assert.Equal((223, 224), ((int)FrameType.CommentReportRequest, (int)FrameType.CommentReportResult));
        Assert.Equal(new CommentReportRequest("harassment", "A private explanation."), Decode(
            """{"reasonCode":" Harassment ","detail":" A private explanation. ","scopedCredential":null}"""u8));
        Assert.Equal(new CommentReportRequest("other", null), Decode("""{"reasonCode":"other","detail":"  "}"""u8));
        foreach (var bad in new byte[][]
        {
            """{"reasonCode":"other","scopedCredential":"different-purpose"}"""u8.ToArray(),
            """{"reasonCode":"unsupported"}"""u8.ToArray(),
            JsonSerializer.SerializeToUtf8Bytes(new { reasonCode = "other", detail = new string('x', 1001) }),
        })
            Assert.Throws<ProtocolException>(() => Decode(bad));
        var receipt = Wire.EncodeCommentReportResult(new(true, "comment_report_duplicate", 31, true));
        using var json = DecodeJson(receipt, FrameType.CommentReportResult);
        Assert.Equal(new[] { "success", "code", "reportId", "duplicate" }, json.RootElement.EnumerateObject().Select(field => field.Name));
        Assert.Equal((31L, true), (json.RootElement.GetProperty("reportId").GetInt64(), json.RootElement.GetProperty("duplicate").GetBoolean()));

        static CommentReportRequest Decode(ReadOnlySpan<byte> payload) =>
            Wire.DecodeCommentReportRequest(Aeds.Encode(FrameType.CommentReportRequest, payload));
    }
}
