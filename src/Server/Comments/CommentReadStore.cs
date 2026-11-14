using System.Data;
using FsusBlog.V2.Contracts;
using Npgsql;

namespace FsusBlog.V2.Server.Comments;

internal sealed class CommentReadStore(NpgsqlDataSource source)
{
    private const int PreviewLimit = 3;
    private static readonly CommentAuthor Tombstone = new(CommentAuthorMode.LegacyPseudonymous, "已删除评论", "zh-CN");

    // A single unknown-viewer policy excludes every region-blocked node's content.
    // Only the structural ancestors needed to reach an approved descendant survive as tombstones.
    private const string Visible = """
        with recursive public_article as (
            select a.id from public.article a
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            where a.id=$1 and not a.deleted and p.published_at<=statement_timestamp()
        ), approved as (
            select c.id,c.parent_id
            from public.comment c join public_article a on a.id=c.article_id
            where c.moderation_status=1 and not c.deleted
              and not exists(select 1 from public.comment_blocked_region b where b.article_id=$1 and b.comment_id=c.id)
        ), chain(id,parent_id) as (
            select id,parent_id from approved
            union
            select c.id,c.parent_id
            from public.comment c join chain child on child.parent_id=c.id
            where c.article_id=$1
        ), counts as (
            select parent_id, count(*)::integer as children from chain where parent_id is not null group by parent_id
        ), nodes as materialized (
            select c.id,c.parent_id,c.root_id,c.reply_to_id,c.depth,coalesce(counts.children,0) as children,
                c.created_at, a.id is not null as visible, a.id is not null and c.edited_at is not null as edited,
                case when a.id is not null then c.body end as body,
                case when a.id is not null then c.author_mode end as author_mode,
                case when a.id is not null then c.display_name end as display_name,
                case when a.id is not null then c.display_language end as display_language,
                case when a.id is not null then c.scope_label end as scope_label,
                case when ar.id is not null then target.author_mode end as reply_author_mode,
                case when ar.id is not null then target.display_name end as reply_display_name,
                case when ar.id is not null then target.display_language end as reply_display_language,
                case when ar.id is not null then target.scope_label end as reply_scope_label
            from chain join public.comment c on c.article_id=$1 and c.id=chain.id
            left join approved a on a.id=c.id
            left join counts on counts.parent_id=c.id
            left join approved ar on ar.id=c.reply_to_id and a.id is not null
            left join public.comment target on target.article_id=$1 and target.id=ar.id
        )
        """;

    internal async Task<byte[]> Roots(int article, long? cursor, int limit, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await Start(db, ct);
        var roots = await Read(db, tx, """
            select * from nodes where parent_id is null and ($2=0 or id<$2)
            order by id desc limit $3
            """, ct, article, cursor ?? 0, limit + 1);
        var next = TakePage(roots, limit);
        var previews = await Read(db, tx, """
            select * from (
                select nodes.*,row_number() over(partition by parent_id order by id) as ordinal
                from nodes where parent_id=any($2)
            ) children where ordinal<=$3 order by parent_id,id
            """, ct, article, roots.Select(node => node.Id).ToArray(), PreviewLimit);
        var byRoot = previews.ToLookup(child => child.ParentId);
        return CommentReadWire.Roots(roots.Select(root => new CommentRoot(
            root with { HasMoreChildren = root.ChildCount > PreviewLimit }, byRoot[root.Id].ToArray())).ToArray(), next);
    }

    internal async Task<byte[]> Children(int article, long parent, long? cursor, int limit, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await Start(db, ct);
        var parentRows = await Read(db, tx, "select * from nodes where id=$2", ct, article, parent);
        var root = parentRows.Count == 0 ? 0 : parentRows[0].RootId;
        if (root == 0) return CommentReadWire.Children(parent, 0, [], null);
        var children = await Read(db, tx, """
            select * from nodes where parent_id=$2 and id>$3 order by id limit $4
            """, ct, article, parent, cursor ?? 0, limit + 1);
        return CommentReadWire.Children(parent, root, children, TakePage(children, limit));
    }

    internal async Task<byte[]> Thread(int article, long root, long? cursor, int limit, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await Start(db, ct);
        var replies = await Read(db, tx, """
            select * from nodes where root_id=$2 and parent_id is not null and id>$3 order by id limit $4
            """, ct, article, root, cursor ?? 0, limit + 1);
        return CommentReadWire.Thread(root, replies, TakePage(replies, limit));
    }

    internal async Task<byte[]> Context(int article, long comment, int window, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await Start(db, ct);
        var path = await Read(db, tx, """
            , path(id,parent_id) as (
                select id,parent_id from nodes where id=$2 and visible
                union all
                select p.id,p.parent_id from nodes p join path on path.parent_id=p.id
            )
            select nodes.* from nodes join path on path.id=nodes.id order by depth
            """, ct, article, comment);
        if (path.Count == 0) return CommentReadWire.Context(null, [], []);
        var target = path[^1];
        path.RemoveAt(path.Count - 1);
        var half = window / 2;
        var neighbors = await Read(db, tx, """
            (select * from nodes where coalesce(parent_id,0)=$2 and id<$3 order by id desc limit $4)
            union all
            (select * from nodes where coalesce(parent_id,0)=$2 and id>$3 order by id limit $4)
            order by id
            """, ct, article, target.ParentId ?? 0, comment, half + 1);
        var before = neighbors.Where(row => row.Id < comment).ToArray();
        var after = neighbors.Where(row => row.Id > comment).ToArray();
        return CommentReadWire.Context(target, path, before.TakeLast(half).Concat(after.Take(half)).ToArray(),
            before.Length > half, after.Length > half);
    }

    private static long? TakePage(List<CommentNode> rows, int limit)
    {
        if (rows.Count <= limit) return null;
        rows.RemoveAt(rows.Count - 1);
        return rows[^1].Id;
    }

    private static async Task<NpgsqlTransaction> Start(NpgsqlConnection db, CancellationToken ct)
    {
        var tx = await db.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        try
        {
            await using var settings = Store.Sql(db, tx, "set transaction read only; set local statement_timeout = '2s'");
            await settings.ExecuteNonQueryAsync(ct);
            return tx;
        }
        catch
        {
            await tx.DisposeAsync();
            throw;
        }
    }

    private static async Task<List<CommentNode>> Read(NpgsqlConnection db, NpgsqlTransaction tx, string query,
        CancellationToken ct, params object[] parameters)
    {
        await using var command = Store.Sql(db, tx, Visible + "\n" + query, parameters);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<CommentNode>();
        while (await reader.ReadAsync(ct))
        {
            var visible = reader.GetBoolean(7);
            var children = reader.GetInt32(5);
            CommentAuthor? replyAuthor = null;
            // The target may be private even when this node has an approved author.
            var replyId = visible && !reader.IsDBNull(14) ? NullableId(reader, 3) : null;
            if (visible && !reader.IsDBNull(3)) replyAuthor = replyId is null ? Tombstone : ReadAuthor(reader, 14);
            rows.Add(new CommentNode(reader.GetInt64(0), NullableId(reader, 1), reader.GetInt64(2),
                replyId, reader.GetInt32(4), children, !visible, children > 0,
                reader.GetFieldValue<DateTimeOffset>(6), visible ? reader.GetString(9) : "该回复已删除",
                visible ? ReadAuthor(reader, 10) : Tombstone, replyAuthor, reader.GetBoolean(8)));
        }
        return rows;
    }

    private static long? NullableId(NpgsqlDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : reader.GetInt64(index);

    private static CommentAuthor ReadAuthor(NpgsqlDataReader reader, int index) => new(
        (CommentAuthorMode)reader.GetInt16(index), reader.GetString(index + 1), reader.GetString(index + 2),
        reader.IsDBNull(index + 3) ? null : reader.GetString(index + 3));
}
