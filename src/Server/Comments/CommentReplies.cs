using System.Globalization;
using System.Text;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentReplies
{
    internal const string Setting = "FSUSBLOG_SIGNED_IN_COMMENT_REPLIES";
    internal sealed record Parent(long Root, int Depth);
    internal sealed record ApprovedNotice(int Article, long Reply, Guid Recipient, string Name, string Body, long Version);

    internal static async Task<Parent> LockParent(NpgsqlConnection db, NpgsqlTransaction tx, int article, long parent,
        CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Comment replies are unavailable.");
        await using var query = Store.Sql(db, tx, """
            select p.root_id,p.depth
            from public.comment p join public.comment r on r.article_id=p.article_id and r.id=p.root_id
            join public.article a on a.id=p.article_id and not a.deleted
            join public.article_publication publication on publication.article_id=a.id and publication.revision=a.published_revision
                and publication.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=publication.revision
                and snapshot.publication_id=publication.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where p.article_id=$1 and p.id=$2 and p.moderation_status=1 and not p.deleted
                and r.moderation_status=1 and not r.deleted and r.parent_id is null and p.depth<32
                and not exists (select 1 from public.comment_blocked_region b
                    where b.article_id=p.article_id and b.comment_id in (p.id,r.id))
            for update of p for share of r,a,publication,snapshot,rights
            """, article, parent);
        Parent target;
        await using (var row = await query.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct))
                throw new BusinessException(Rejection.NotFound, "This comment cannot accept a reply.");
            target = new(row.GetInt64(0), row.GetInt32(1));
        }
        if (await SqlCommands.Scalar(db, tx, ct, """
            select exists(select 1 from public.comment where article_id=$1 and parent_id=$2 offset 499 limit 1)
            """, article, parent) is true)
            throw new BusinessException(Rejection.Conflict, "This comment reached its reply limit.");
        return target;
    }

    // The caller holds the approved reply row for the whole mutation, including Inbox writes and its receipt.
    internal static async Task DeliverApproved(NpgsqlConnection db, NpgsqlTransaction tx, int article, long reply,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct)) return;
        var notice = await FindApprovedNotice(db, tx, article, reply, ct);
        if (notice is not null) await DeliverNotice(db, tx, notice, fenceVisibleMessages, ct);
    }

    internal static async Task<ApprovedNotice?> FindApprovedNotice(NpgsqlConnection db, NpgsqlTransaction tx, int article, long reply,
        CancellationToken ct)
    {
        await using var due = Store.Sql(db, tx, """
            select recipient.id,c.display_name,c.body,c.moderation_version
            from public.comment c
            join public.comment_account_owner author on author.article_id=c.article_id and author.comment_id=c.id
            join public.comment p on p.article_id=c.article_id and p.id=c.reply_to_id and p.id=c.parent_id
            join public.comment r on r.article_id=p.article_id and r.id=p.root_id
            join public.comment_account_owner target on target.article_id=p.article_id and target.comment_id=p.id
            join public.blog_user recipient on recipient.id=target.user_id and recipient.enabled and recipient.id<>author.user_id
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication publication on publication.article_id=a.id and publication.revision=a.published_revision
                and publication.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=publication.revision
                and snapshot.publication_id=publication.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where c.article_id=$1 and c.id=$2 and c.moderation_status=1 and not c.deleted and c.author_mode=3
                and p.moderation_status=1 and not p.deleted and p.author_mode=3
                and r.moderation_status=1 and not r.deleted and r.parent_id is null
                and not exists (select 1 from public.comment_blocked_region b
                    where b.article_id=c.article_id and b.comment_id in (c.id,p.id,r.id))
                and not exists (select 1 from public.comment_reply_notice delivered
                    where delivered.article_id=c.article_id and delivered.reply_id=c.id)
            for share of recipient,p,r,a,publication,snapshot,rights,target,author
            """, article, reply);
        await using var row = await due.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? new(article, reply, row.GetGuid(0), row.GetString(1), row.GetString(2), row.GetInt64(3)) : null;
    }

    internal static async Task DeliverNotice(NpgsqlConnection db, NpgsqlTransaction tx, ApprovedNotice notice,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        var excerpt = string.Concat(notice.Body.EnumerateRunes().Take(40).Select(rune => rune.ToString()));
        var text = string.Create(CultureInfo.InvariantCulture,
            $"{notice.Name} 回复了您的评论：{excerpt}。定位：/article/{notice.Article}#comment-{notice.Reply}");
        var inbox = new InboxStore(db, tx, notice.Recipient, fenceVisibleMessages);
        var delivered = await inbox.SendAttributedNotice("收到新的评论回复", text, ct);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.comment_reply_notice(article_id,reply_id,recipient_id,conversation_id,message_id,moderation_version,delivered_at)
            values($1,$2,$3,$4,$5,$6,$7)
            """, notice.Article, notice.Reply, notice.Recipient, delivered.ConversationId, delivered.Id, notice.Version, delivered.SentAt);
    }
}
