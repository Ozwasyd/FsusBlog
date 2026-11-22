using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Markdig;
using Markdig.Parsers;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class CanvasStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, byte[] sessionDigest)
{
    private static readonly MarkdownPipeline SourceLocations = new MarkdownPipelineBuilder().UsePreciseSourceLocation().Build();
    private readonly CanvasGraphStore graph = new(db, tx, actor);

    internal async Task<CanvasCreated> Create(CanvasCreate input, CancellationToken ct)
    {
        // Serialize this owner's bounded Canvas admission and reuse of the creation coordinates.
        await Store.LockCommand(db, tx, actor.Id, Guid.Empty, ct);
        var fingerprint = SHA256.HashData(Wire.EncodeCanvasCreate(input));
        if (await graph.Replay(input.CanvasId, input.EdgeId, CanvasGraphStore.SeedLinkKind, fingerprint, ct) is { } existing)
            return new(input.CanvasId, input.EdgeId, existing.Revision);
        await FindArticles(input.HostArticleId, input.TargetArticleId, ct);
        var from = new CanvasNode(Guid.NewGuid(), CanvasNodeKind.ArticleReference, new(0, 0, 16000, 8000), input.HostArticleId);
        var to = new CanvasNode(Guid.NewGuid(), CanvasNodeKind.ArticleReference, new(20000, 0, 16000, 8000), input.TargetArticleId);
        var value = new CanvasGraph([from, to],
            [new(input.EdgeId, CanvasGraphEdgeKind.ExplicitReferenceNote, from.Id, to.Id, 0)]);
        var receipt = await graph.Create(input.CanvasId, input.EdgeId, CanvasGraphStore.SeedLinkKind, fingerprint,
            "Canvas", CanvasViewport.Default, value, ct);
        return new(input.CanvasId, input.EdgeId, receipt.Revision);
    }

    internal async Task<CanvasLinkPlan> Preview(CanvasPreview input, CancellationToken ct, bool visualOnly = false)
    {
        var edge = await ReadEdge(input.CanvasId, input.EdgeId, ct) ?? throw Missing();
        var articles = await FindArticles(edge.HostArticleId, edge.TargetArticleId, ct);
        var intent = new CanvasLinkIntent(input.CanvasId, input.EdgeId, input.CanvasRevision, input.HostRevision,
            input.TargetRevision, input.SourceOffset, visualOnly);
        var change = Build(edge, intent, articles.Host, articles.Target, actor);
        await SqlCommands.Execute(db, tx, ct, """
            delete from public.canvas_link_plan where canvas_id=$1 and applied_revision is null and expires_at<=clock_timestamp()
            """, edge.CanvasId);
        await using (var budget = Store.Sql(db, tx, """
            select count(*) from public.canvas_link_plan where canvas_id=$1 and applied_revision is null
            """, edge.CanvasId))
            if ((long)(await budget.ExecuteScalarAsync(ct))! >= 20) throw Conflict();

        var planId = Guid.NewGuid();
        await using var plan = Store.Sql(db, tx, """
            insert into public.canvas_link_plan
            (id,canvas_id,edge_id,canvas_revision,host_revision,target_revision,source_offset,insert_digest,session_digest,session_generation,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,date_trunc('second', clock_timestamp()) + interval '2 minutes')
            returning expires_at
            """, planId, edge.CanvasId, edge.EdgeId, intent.CanvasRevision, intent.HostRevision,
            intent.TargetRevision, intent.SourceOffset, Digest(change.Inserted, intent.VisualOnly), sessionDigest, actor.Generation);
        var expires = (DateTime)(await plan.ExecuteScalarAsync(ct))!;
        return new(planId, edge.Revision, edge.HostArticleId, intent.HostRevision, edge.TargetArticleId,
            intent.TargetRevision, intent.SourceOffset, change.Inserted, new DateTimeOffset(expires).ToUnixTimeSeconds());
    }

    internal async Task<CanvasLinked> Confirm(Guid id, CancellationToken ct)
    {
        // Use the same lock order as article writes: actor/key first, article second.
        await Store.LockCommand(db, tx, actor.Id, id, ct);
        // Preview maintenance already holds the canvas lock before deleting expired plans.
        // Take the same locks in the same order even if the planner is cleaning this plan up.
        await using (var canvas = Store.Sql(db, tx, """
            select c.id from public.authoring_canvas c where c.owner_id=$2 and
            c.id=(select p.canvas_id from public.canvas_link_plan p
                  where p.id=$1 and p.session_digest=$3 and p.session_generation=$4) for update of c
            """, id, actor.Id, sessionDigest, actor.Generation))
            if (await canvas.ExecuteScalarAsync(ct) is not Guid) throw Missing();
        Plan saved;
        await using (var read = Store.Sql(db, tx, """
            select p.canvas_id,p.edge_id,p.canvas_revision,p.host_revision,p.target_revision,p.source_offset,p.insert_digest,
                p.expires_at>clock_timestamp(),p.applied_article_id,p.applied_revision,p.applied_canvas_revision
            from public.canvas_link_plan p join public.authoring_canvas c on c.id=p.canvas_id
            where p.id=$1 and c.owner_id=$2 and p.session_digest=$3 and p.session_generation=$4 for update of p
            """, id, actor.Id, sessionDigest, actor.Generation))
        await using (var row = await read.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Missing();
            saved = new(new(row.GetGuid(0), row.GetGuid(1), row.GetInt64(2), row.GetInt64(3),
                row.GetInt64(4), row.GetInt32(5)), row.GetFieldValue<byte[]>(6), row.GetBoolean(7),
                row.IsDBNull(8) ? null : new(id, row.GetInt32(8), row.GetInt64(9), row.GetInt64(10)));
        }
        var edge = await ReadEdge(saved.Intent.CanvasId, saved.Intent.EdgeId, ct) ?? throw Missing();
        var articles = await FindArticles(edge.HostArticleId, edge.TargetArticleId, ct);
        if (saved.Receipt is not null) return saved.Receipt;
        if (!saved.Current) throw Conflict();
        var intent = saved.Intent with { VisualOnly = !edge.ExplicitReference };
        var change = Build(edge, intent, articles.Host, articles.Target, actor);
        if (!CryptographicOperations.FixedTimeEquals(saved.Digest, Digest(change.Inserted, intent.VisualOnly))) throw Conflict();

        var edit = Publishing.Validate(ArticleAction.Save,
            new(articles.Host.Id, articles.Host.Revision, id, articles.Host.Title, change.Body));
        var updated = await Store.Execute(db, tx, actor, ArticleAction.Save, edit, ct);
        if (!updated.Changed) throw Conflict();

        var receipt = await graph.RecordLink(edge.CanvasId, id, saved.Intent.CanvasRevision, saved.Digest, ct);
        long revision = receipt.Revision;
        await using var finish = Store.Sql(db, tx, """
            update public.canvas_link_plan set applied_article_id=$2,applied_revision=$3,applied_canvas_revision=$4
            where id=$1 and expires_at>clock_timestamp() and applied_revision is null
            """, id, updated.Article.Id, updated.Article.Revision, revision);
        if (await finish.ExecuteNonQueryAsync(ct) != 1) throw Conflict();
        return new(id, updated.Article.Id, updated.Article.Revision, revision);
    }

    private async Task<CanvasEdge?> ReadEdge(Guid canvas, Guid edge, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select c.revision,s.article_id,t.article_id,e.explicit_reference
            from public.authoring_canvas c join public.canvas_edge e on e.canvas_id=c.id
            join public.canvas_node s on s.canvas_id=c.id and s.id=e.source_node_id
            join public.canvas_node t on t.canvas_id=c.id and t.id=e.target_node_id
            where c.id=$1 and e.id=$2 and c.owner_id=$3 and not c.deleted
                and s.kind=0 and t.kind=0 and s.article_id<>t.article_id
                and s.pinned_revision is null and t.pinned_revision is null for update of c,e,s,t
            """, canvas, edge, actor.Id);
        await using var row = await read.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? new(canvas, edge, row.GetInt64(0), row.GetInt32(1), row.GetInt32(2),
            row.GetBoolean(3)) : null;
    }

    private async Task<(ArticleState Host, CanvasTarget Target)> FindArticles(int host, int target, CancellationToken ct)
    {
        // A fixed order lets independent canvases reference the same pair in opposite directions.
        if (host < target) return (await Store.Find(db, tx, actor, host, true, ct), await FindTarget(target, ct));
        var linkTarget = await FindTarget(target, ct);
        return (await Store.Find(db, tx, actor, host, true, ct), linkTarget);
    }

    private async Task<CanvasTarget> FindTarget(int target, CancellationToken ct)
    {
        // Derive the label only from the published coordinate. The latest saved draft can
        // have a different title or body, and neither belongs in the rendered link plan.
        await using var read = Store.Sql(db, tx, """
            select a.owner_id,p.revision,r.title from public.article a
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
            where a.id=$1 and a.owner_id=$2 and not a.deleted for share of a
            """, target, actor.Id);
        await using var row = await read.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? new(target, row.GetGuid(0), row.GetInt64(1), row.GetString(2)) : throw Missing();
    }

    internal static (string Inserted, string Body) Build(CanvasEdge edge, CanvasLinkIntent intent, ArticleState host,
        CanvasTarget target, Identity actor)
    {
        var change = CanvasLink.Build(edge, intent, host, target, actor);
        // A selected end-of-source offset can still lie inside an open fence, HTML or another
        // Markdown container. Confirm the newly appended text is exactly one standalone link.
        var parsed = Markdown.Parse(change.Body, SourceLocations);
        var appended = parsed.LastOrDefault() as ParagraphBlock;
        if (appended?.Inline?.FirstChild is not LinkInline { IsImage: false, NextSibling: null } link ||
            link.Url != $"/article/{target.Id}" || link.Span.Start < intent.SourceOffset ||
            link.Span.End != change.Body.Length - 1)
            throw new BusinessException(Rejection.Invalid, "Choose an insertion outside Markdown blocks.");
        return change;
    }

    // Keep existing reference plans valid. A visual plan can only be created by an explicit visual preview.
    private static byte[] Digest(string value, bool visualOnly) =>
        SHA256.HashData(Encoding.UTF8.GetBytes(visualOnly ? "canvas-link/visual-only\0" + value : value));
    private static BusinessException Missing() => new(Rejection.NotFound, "Canvas link is unavailable.");
    private static BusinessException Conflict() => new(Rejection.Conflict, "This Canvas link changed or its plan expired.");
    private sealed record Plan(CanvasLinkIntent Intent, byte[] Digest, bool Current, CanvasLinked? Receipt);
}
