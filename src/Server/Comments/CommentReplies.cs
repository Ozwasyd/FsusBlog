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
        await using var capacity = Store.Sql(db, tx, """
            select exists(select 1 from public.comment where article_id=$1 and parent_id=$2 offset 499 limit 1)
            """, article, parent);
        if (await capacity.ExecuteScalarAsync(ct) is true)
            throw new BusinessException(Rejection.Conflict, "This comment reached its reply limit.");
        return target;
    }

    // The caller holds the approved reply row for the whole mutation, including Inbox writes and its receipt.
    internal static async Task DeliverApproved(NpgsqlConnection db, NpgsqlTransaction tx, int article, long reply,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        if (!await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct)) return;

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
        Guid recipient;
        string displayed, comment;
        long version;
        await using (var row = await due.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) return;
            (recipient, displayed, comment, version) = (row.GetGuid(0), row.GetString(1), row.GetString(2), row.GetInt64(3));
        }
        var excerpt = string.Concat(comment.EnumerateRunes().Take(40).Select(rune => rune.ToString()));
        var text = string.Create(CultureInfo.InvariantCulture, $"{displayed} 回复了您的评论：{excerpt}。定位：/article/{article}#comment-{reply}");
        var inbox = new InboxStore(db, tx, recipient, fenceVisibleMessages);
        var delivered = await inbox.SendAttributedNotice("收到新的评论回复", text, ct);
        await using var record = Store.Sql(db, tx, """
            insert into public.comment_reply_notice(article_id,reply_id,recipient_id,conversation_id,message_id,moderation_version,delivered_at)
            values($1,$2,$3,$4,$5,$6,$7)
            """, article, reply, recipient, delivered.ConversationId, delivered.Id, version, delivered.SentAt);
        await record.ExecuteNonQueryAsync(ct);
    }
}
