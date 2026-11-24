namespace FsusBlog.V2.Cli;

internal static class CommentMaintenance
{
    internal static async Task AssignHandle(NpgsqlConnection db, string account, string name, CancellationToken ct)
    {
        if (!Guid.TryParseExact(account, "D", out var id) || id == Guid.Empty)
            throw new ArgumentException("Specify an existing account UUID.");
        name = ReadText(name, 384);
        await CurrentSchema.VerifyAsync(db, ct);
        if (await global::Cli.ExecuteAsync(db, null, """
            insert into public.comment_public_handle(user_id,display_name)
            select id,$2 from public.blog_user where id=$1 and enabled
            on conflict(user_id) do update set display_name=excluded.display_name
            """, ct, id, name) != 1) throw new InvalidOperationException("Enabled account not found.");
    }

    internal static async Task SetArticlePolicy(NpgsqlConnection db, string article, string state, CancellationToken ct)
    {
        var id = ArticleId(article);
        var sql = state switch
        {
            "enable" => "insert into public.comment_public_write(article_id) values($1) on conflict do nothing",
            "disable" => "delete from public.comment_public_write where article_id=$1",
            _ => throw new ArgumentException("Use enable or disable for the article comment policy.")
        };
        await CurrentSchema.VerifyAsync(db, ct);
        await global::Cli.ExecuteAsync(db, null, sql, ct, id);
    }

    internal static async Task Moderate(NpgsqlConnection db, string article, string comment, string expected, string decision,
        string reason, CancellationToken ct)
    {
        int articleId = ArticleId(article);
        if (!long.TryParse(comment, NumberStyles.None, CultureInfo.InvariantCulture, out var commentId) || commentId <= 0)
            throw new ArgumentException("Specify a positive comment ID.");
        if (!short.TryParse(expected, NumberStyles.None, CultureInfo.InvariantCulture, out var from) || from is < 0 or > 3)
            throw new ArgumentException("Expected moderation status must be 0, 1, 2, or 3.");
        var to = decision switch
        {
            "approve" => (short)1, "reject" => (short)2, "hide" => (short)3,
            _ => throw new ArgumentException("Use approve, reject, or hide.")
        };
        if (from == to) throw new ArgumentException("Moderation requires a change in status.");
        reason = ReadText(reason, 1024);
        await CurrentSchema.VerifyAsync(db, ct);
        if (await global::Cli.ExecuteAsync(db, null, """
            with changed as (
                update public.comment c set moderation_status=$4,moderation_version=moderation_version+1
                where c.article_id=$1 and c.id=$2 and c.moderation_status=$3 and not c.deleted
                    and (c.moderation_status=1 or c.reply_to_id is null or c.reply_to_id is distinct from c.parent_id or c.author_mode<>3
                         or not exists(select 1 from public.comment_submit_command s where (s.article_id,s.comment_id)=(c.article_id,c.id)))
                returning c.article_id,c.id
            )
            insert into public.comment_moderation_log(article_id,comment_id,previous_status,next_status,moderator_db_role,reason)
            select article_id,id,$3,$4,current_user,$5 from changed
            """, ct, articleId, commentId, from, to, reason) != 1)
            throw new InvalidOperationException("Comment changed or requires attributed online reply moderation.");
    }

    private static int ArticleId(string value) =>
        int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
            ? id : throw new ArgumentException("Specify a positive article ID.");

    private static string ReadText(string value, int maxBytes)
    {
        var text = value.Trim();
        if (text.Length == 0 || Encoding.UTF8.GetByteCount(text) > maxBytes || text.Any(char.IsControl))
            throw new ArgumentException("The value is empty, too long, or contains control characters.");
        return text;
    }
}
