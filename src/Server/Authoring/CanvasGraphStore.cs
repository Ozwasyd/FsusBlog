using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class CanvasGraphStore(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor)
{
    private readonly CanvasHistoryStore history = new(db, tx);
    private const int RetainedDocuments = 4_000;
    private const long RetainedRevisions = 100_000;
    internal const int LinkKind = 3;
    internal const int SeedLinkKind = 4;
    private const int ImportBundleKind = 7;
    private const string Receipt = "e.canvas_id,e.revision,e.title,e.viewport_x,e.viewport_y,e.viewport_zoom,e.deleted,e.node_count,e.edge_count,e.touched_at";
    private const string Node = "id,kind,x,y,width,height,article_id,anchor,pinned_revision,note,member_ids";
    private const string Edge = "id,explicit_reference,source_node_id,target_node_id,sort_order,label";

    internal async Task<IReadOnlyList<CanvasGraphReceipt>> List(CancellationToken ct)
    {
        await using var load = Store.Sql(db, tx, $"""
            select {Receipt} from public.authoring_canvas c
            join public.canvas_document_event e on e.canvas_id=c.id and e.revision=c.revision
            where c.owner_id=$1 and not c.deleted order by c.touched_at desc, c.id limit $2
            """, actor.Id, WireLimits.CanvasGraphMaxDocuments);
        await using var rows = await load.ExecuteReaderAsync(ct);
        var result = new List<CanvasGraphReceipt>();
        while (await rows.ReadAsync(ct)) result.Add(ReadReceipt(rows));
        return result;
    }

    internal async Task<CanvasGraphPage> Page(Guid id, long revision, int offset, CancellationToken ct)
    {
        if (id == Guid.Empty || revision < 0 || offset < 0 || offset != 0 && revision == 0)
            throw Invalid("Invalid Canvas document page.");
        var current = await Current(id, write: false, ct) ?? throw Missing();
        if (current.Deleted) throw Missing();
        if (revision != 0 && revision != current.Revision) throw Conflict();
        if (offset >= current.NodeCount + current.EdgeCount && offset != 0)
            throw Invalid("Invalid Canvas document page offset.");

        if (offset < current.NodeCount)
        {
            var nodes = await ReadNodes(id, offset, WireLimits.CanvasGraphMaxPageNodes, ct);
            var page = new List<CanvasNodeFrame>(nodes.Count);
            int bytes = 0;
            foreach (var node in nodes)
            {
                // Overestimate fixed fields and length prefixes, and charge all variable bytes.
                bytes += 64 + (node.Anchor is null ? 0 : Encoding.UTF8.GetByteCount(node.Anchor)) +
                    (node.Text is null ? 0 : Encoding.UTF8.GetByteCount(node.Text)) + 16 * node.MemberIds.Length;
                if (bytes > WireLimits.CanvasGraphMaxPageNodeBytes) break;
                page.Add(ToFrame(node));
            }
            return new(current, NextOffset(current, offset, page.Count), page, []);
        }

        var edges = await ReadEdges(id, offset - current.NodeCount, WireLimits.CanvasGraphMaxPageEdges, ct);
        return new(current, NextOffset(current, offset, edges.Count), [], edges.Select(ToFrame).ToArray());
    }

    internal async Task<CanvasReferenceResolution> Resolve(Guid id, Guid nodeId, long revision, bool requireCurrent, CancellationToken ct)
    {
        if (id == Guid.Empty || nodeId == Guid.Empty || revision <= 0)
            throw Invalid("A valid Canvas reference coordinate is required.");
        var current = await Current(id, write: false, ct) ?? throw Missing();
        if (current.Deleted) throw Missing();
        if (current.Revision != revision) throw Conflict();
        return await CanvasReferenceStore.Resolve(db, tx, actor.Id, id, nodeId, current.Revision, requireCurrent, ct);
    }

    internal async Task<byte[]> ExportBundle(Guid id, long revision, CancellationToken ct)
    {
        if (id == Guid.Empty || revision <= 0) throw Invalid("An exact Canvas revision is required.");
        var current = await Current(id, write: false, ct) ?? throw Missing();
        if (current.Deleted) throw Missing();
        if (current.Revision != revision) throw Conflict();
        var graph = await LoadGraph(current, ct);
        await CheckReferences(graph.Nodes, ct);
        var view = current.Viewport;
        return CanvasPortableBundle.Export(current.Title, new(view.X, view.Y, view.Zoom), revision, graph).Encode();
    }

    internal async Task<CanvasGraphReceipt> ImportBundle(CanvasBundleExecute input, byte[] fingerprint, CancellationToken ct)
    {
        if (CanvasBundleStore.Digest(input.Bundle) != input.Digest)
            throw Invalid("The Canvas bundle is different from the validated package.");
        await Store.LockCommand(db, tx, actor.Id, Guid.Empty, ct);
        if (await Replay(input.CanvasId, input.CommandId, ImportBundleKind, fingerprint, ct) is { } replay)
            return replay;
        var bundle = CanvasBundleStore.Read(input.Bundle);
        var mappings = input.Mappings.ToDictionary(mapping => mapping.Slot,
            mapping => new CanvasPortableTarget(mapping.ArticleId, mapping.PinnedRevision));
        var graph = bundle.Materialize(mappings, input.CanvasId);
        await CheckReferences(graph.Nodes, ct);
        var view = bundle.Viewport;
        return await Create(input.CanvasId, input.CommandId, ImportBundleKind, fingerprint, Title(bundle.Title),
            Viewport(new(view.X, view.Y, view.Zoom)), graph, ct);
    }

    internal async Task<CanvasGraphHistory> History(Guid id, long revision, CancellationToken ct)
    {
        if (id == Guid.Empty || revision <= 0) throw Invalid("A valid Canvas revision is required.");
        var current = await Current(id, write: false, ct) ?? throw Missing();
        if (current.Deleted) throw Missing();
        if (current.Revision != revision) throw Conflict();
        return await history.Heads(id, revision, ct);
    }

    internal async Task<CanvasGraphReceipt> Write(CanvasGraphCommand command, byte[] fingerprint, CancellationToken ct)
    {
        if (command.Action == CanvasGraphAction.Create)
        {
            await Store.LockCommand(db, tx, actor.Id, Guid.Empty, ct);
            if (await Replay(command.Id, command.CommandId, (int)command.Action, fingerprint, ct) is { } replay) return replay;
            var initial = Apply(CanvasGraph.Empty, command.Changes);
            await CheckReferences(initial.Nodes, ct);
            return await Create(command.Id, command.CommandId, (int)command.Action, fingerprint, Title(command.Title),
                Viewport(command.Viewport ?? CanvasViewport.Default), initial, ct);
        }

        var current = await Current(command.Id, write: true, ct) ?? throw Missing();
        if (await Replay(command.Id, command.CommandId, (int)command.Action, fingerprint, ct) is { } earlier) return earlier;
        if (current.Deleted) throw Missing();
        if (current.Revision != command.ExpectedRevision || current.Revision >= RetainedRevisions) throw Conflict();

        if (command.Action == CanvasGraphAction.Delete)
        {
            if (command.Title.Length != 0 || command.Viewport.HasValue || command.Changes.Count != 0)
                throw Invalid("Delete accepts only exact Canvas document coordinates.");
            await DeleteGraph(command.Id, ct);
            var deleted = await Advance(current with { Title = "", Viewport = CanvasViewport.Default, Deleted = true, NodeCount = 0, EdgeCount = 0 },
                command.CommandId, (int)command.Action, fingerprint, ct);
            await history.Clear(current.Id, deleted.Revision, ct);
            return deleted;
        }
        if (command.Action is CanvasGraphAction.Undo or CanvasGraphAction.Redo)
            return await ReplayHistory(current, command, fingerprint, ct);

        string title = command.Title.Length == 0 ? current.Title : Title(command.Title);
        var viewport = command.Viewport.HasValue ? Viewport(command.Viewport.Value) : current.Viewport;
        var before = command.Changes.Count == 0 ? CanvasGraph.Empty : await LoadGraph(current, ct);
        var after = Apply(before, command.Changes);
        var patch = CanvasHistoryPatch.Between(before, after);
        if (patch.Nodes.IsEmpty && patch.Edges.IsEmpty && title == current.Title && viewport == current.Viewport)
            throw Invalid("Choose a Canvas change.");
        if (!patch.Nodes.IsEmpty || !patch.Edges.IsEmpty)
            current = await ApplyPatch(current, after, patch, forward: true, ct);

        var applied = await Advance(current with { Title = title, Viewport = viewport }, command.CommandId, (int)command.Action, fingerprint, ct);
        await history.Edit(current.Id, applied.Revision, new(1, new(current.Title, current.Viewport), new(title, viewport), patch), ct);
        return applied;
    }

    private async Task<CanvasGraphReceipt> ReplayHistory(CanvasGraphReceipt current, CanvasGraphCommand command,
        byte[] fingerprint, CancellationToken ct)
    {
        bool undo = command.Action == CanvasGraphAction.Undo;
        var entry = await history.Read(current.Id, current.Revision, undo, ct)
            ?? throw new BusinessException(Rejection.Conflict, "This Canvas has no retained operation in that direction.");
        var payload = entry.Payload;
        var expected = undo ? payload.After : payload.Before;
        var desired = undo ? payload.Before : payload.After;
        if (current.Title != expected.Title || current.Viewport != expected.Viewport)
            throw new BusinessException(Rejection.Conflict, "Canvas history does not match its current metadata.");

        if (!payload.Patch.Nodes.IsEmpty || !payload.Patch.Edges.IsEmpty)
        {
            var before = await LoadGraph(current, ct);
            var after = payload.Patch.Apply(before, forward: !undo);
            current = await ApplyPatch(current, after, payload.Patch, forward: !undo, ct, replay: true);
        }
        var result = await Advance(current with { Title = Title(desired.Title), Viewport = Viewport(desired.Viewport) },
            command.CommandId, (int)command.Action, fingerprint, ct);
        await history.Move(current.Id, result.Revision, entry.Revision, undone: undo, ct);
        return result;
    }

    private async Task<CanvasGraph> LoadGraph(CanvasGraphReceipt current, CancellationToken ct)
    {
        var graph = new CanvasGraph((await ReadNodes(current.Id, 0, CanvasGraph.MaxNodes, ct)).ToImmutableArray(),
            (await ReadEdges(current.Id, 0, CanvasGraph.MaxEdges, ct)).ToImmutableArray());
        if (graph.Nodes.Length != current.NodeCount || graph.Edges.Length != current.EdgeCount)
            throw new InvalidOperationException("Canvas graph counts do not match the document event.");
        return graph;
    }

    private async Task<CanvasGraphReceipt> ApplyPatch(CanvasGraphReceipt current, CanvasGraph after,
        CanvasHistoryPatch patch, bool forward, CancellationToken ct, bool replay = false)
    {
        var nodes = patch.Nodes.Select(entry => (Expected: forward ? entry.Before : entry.After, Desired: forward ? entry.After : entry.Before)).ToArray();
        var edges = patch.Edges.Select(entry => (Id: entry.Id, Desired: forward ? entry.After : entry.Before)).ToArray();
        var changed = nodes.Where(pair => pair.Desired?.ArticleId is not null &&
            (pair.Expected?.ArticleId, pair.Expected?.Anchor, pair.Expected?.PinnedRevision) !=
            (pair.Desired.ArticleId, pair.Desired.Anchor, pair.Desired.PinnedRevision))
            .Select(pair => pair.Desired!).ToArray();
        // Replaying a saved reference still needs access to the article and its pin.
        // Its current anchor may have changed since the original Canvas operation.
        await CheckReferences(changed, ct, requireResolved: !replay);
        await DeleteIds(current.Id, "delete from public.canvas_edge where canvas_id=$1 and id=any($2)",
            edges.Where(pair => pair.Desired is null).Select(pair => pair.Id).ToArray(), ct);
        foreach (var pair in nodes)
            if (pair.Desired is not null) await StoreNode(current.Id, pair.Desired, ct);
        foreach (var pair in edges)
            if (pair.Desired is not null) await StoreEdge(current.Id, pair.Desired, ct);
        await DeleteIds(current.Id, "delete from public.canvas_node where canvas_id=$1 and id=any($2)",
            nodes.Where(pair => pair.Desired is null).Select(pair => pair.Expected!.Id).ToArray(), ct);
        return current with { NodeCount = after.Nodes.Length, EdgeCount = after.Edges.Length };
    }

    internal async Task<CanvasGraphReceipt> Create(Guid id, Guid key, int kind, byte[] fingerprint, string title,
        CanvasViewport viewport, CanvasGraph graph, CancellationToken ct)
    {
        await using (var budget = Store.Sql(db, tx, """
            select count(*), count(*) filter(where not deleted) from public.authoring_canvas where owner_id=$1
            """, actor.Id))
        await using (var row = await budget.ExecuteReaderAsync(ct))
        {
            await row.ReadAsync(ct);
            if (row.GetInt64(0) >= RetainedDocuments || row.GetInt64(1) >= WireLimits.CanvasGraphMaxDocuments) throw Conflict();
        }
        await using var create = Store.Sql(db, tx, """
            insert into public.authoring_canvas(id,owner_id,revision,title,viewport_x,viewport_y,viewport_zoom,deleted,touched_at)
            values($1,$2,1,$3,$4,$5,$6,false,clock_timestamp()) on conflict do nothing returning touched_at
            """, id, actor.Id, title, viewport.X, viewport.Y, viewport.Zoom);
        if (await create.ExecuteScalarAsync(ct) is not DateTime touched) throw Missing();
        if (graph.Nodes.Length > 64 || graph.Edges.Length > 64)
        {
            await CopySeedNodes(id, graph.Nodes, ct);
            await CopySeedEdges(id, graph.Edges, ct);
        }
        else
        {
            foreach (var node in graph.Nodes) await StoreNode(id, node, ct);
            foreach (var edge in graph.Edges) await StoreEdge(id, edge, ct);
        }
        var receipt = new CanvasGraphReceipt(id, 1, title, viewport, false, graph.Nodes.Length, graph.Edges.Length, touched);
        await Record(receipt, key, kind, fingerprint, ct);
        return receipt;
    }

    internal async Task<CanvasGraphReceipt> RecordLink(Guid id, Guid plan, long expected, byte[] digest, CancellationToken ct)
    {
        var current = await Current(id, write: true, ct) ?? throw Missing();
        if (current.Deleted) throw Missing();
        if (current.Revision != expected || current.Revision >= RetainedRevisions ||
            await Replay(id, plan, LinkKind, digest, ct) is not null) throw Conflict();
        return await Advance(current, plan, LinkKind, digest, ct);
    }

    internal async Task<CanvasGraphReceipt?> Replay(Guid id, Guid key, int kind, byte[] fingerprint, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, $"""
            select {Receipt}, e.command_kind,e.fingerprint from public.canvas_document_event e
            where e.canvas_id=$1 and e.actor_id=$2 and e.command_id=$3
            """, id, actor.Id, key);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (row.GetInt32(10) != kind || !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(11), fingerprint))
            throw Conflict();
        return ReadReceipt(row);
    }

    private async Task<CanvasGraphReceipt?> Current(Guid id, bool write, CancellationToken ct)
    {
        // Lock first, then read the matching event using the next READ COMMITTED statement.
        // A concurrent writer may have advanced the row while we waited for its lock.
        long revision;
        string title;
        CanvasViewport viewport;
        bool deleted;
        DateTimeOffset touched;
        await using (var acquire = Store.Sql(db, tx, """
            select revision,title,viewport_x,viewport_y,viewport_zoom,deleted,touched_at
            from public.authoring_canvas where id=$1 and owner_id=$2
            """ + (write ? " for update" : " for share"), id, actor.Id))
        await using (var row = await acquire.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) return null;
            revision = row.GetInt64(0);
            title = row.GetString(1);
            viewport = new(row.GetInt32(2), row.GetInt32(3), row.GetInt32(4));
            deleted = row.GetBoolean(5);
            touched = row.GetFieldValue<DateTimeOffset>(6);
        }
        await using var read = Store.Sql(db, tx, $"""
            select {Receipt} from public.canvas_document_event e where e.canvas_id=$1 and e.revision=$2
            """, id, revision);
        await using var eventRow = await read.ExecuteReaderAsync(ct);
        if (!await eventRow.ReadAsync(ct)) throw new InvalidOperationException("Canvas document event is missing.");
        var receipt = ReadReceipt(eventRow);
        if (receipt.Title != title || receipt.Viewport != viewport || receipt.Deleted != deleted || receipt.TouchedAt != touched)
            throw new InvalidOperationException("Canvas document metadata does not match its event.");
        return receipt;
    }

    private async Task<CanvasGraphReceipt> Advance(CanvasGraphReceipt current, Guid key, int kind, byte[] fingerprint, CancellationToken ct)
    {
        var viewport = current.Viewport;
        await using var update = Store.Sql(db, tx, """
            update public.authoring_canvas set revision=revision+1,title=$3,viewport_x=$4,viewport_y=$5,
                viewport_zoom=$6,deleted=$7,touched_at=clock_timestamp()
            where id=$1 and revision=$2 returning touched_at
            """, current.Id, current.Revision, current.Title, viewport.X, viewport.Y, viewport.Zoom, current.Deleted);
        if (await update.ExecuteScalarAsync(ct) is not DateTime touched) throw Conflict();
        var receipt = current with { Revision = current.Revision + 1, TouchedAt = touched };
        await Record(receipt, key, kind, fingerprint, ct);
        return receipt;
    }

    private async Task Record(CanvasGraphReceipt current, Guid key, int kind, byte[] fingerprint, CancellationToken ct)
    {
        var viewport = current.Viewport;
        await using var record = Store.Sql(db, tx, """
            insert into public.canvas_document_event(canvas_id,revision,actor_id,command_id,command_kind,fingerprint,
                title,viewport_x,viewport_y,viewport_zoom,deleted,node_count,edge_count,touched_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            """, current.Id, current.Revision, actor.Id, key, kind, fingerprint, current.Title, viewport.X, viewport.Y,
            viewport.Zoom, current.Deleted, current.NodeCount, current.EdgeCount, current.TouchedAt);
        await record.ExecuteNonQueryAsync(ct);
    }

    private async Task CheckReferences(IReadOnlyList<CanvasNode> nodes, CancellationToken ct, bool requireResolved = true)
    {
        var references = nodes.Where(node => node.ArticleId.HasValue)
            .Select(node => (Id: node.ArticleId!.Value, Pin: node.PinnedRevision ?? 0))
            .Distinct().OrderBy(reference => reference.Id).ToArray();
        if (references.Length == 0) return;
        var ids = references.Select(reference => reference.Id).ToArray();
        await using var check = Store.Sql(db, tx, """
            select a.id from unnest($1::integer[],$2::bigint[]) ref(id,pin)
            join public.article a on a.id=ref.id
            where not a.deleted and a.owner_id=$3 and
                (ref.pin=0 or exists(select 1 from public.article_revision r where r.article_id=a.id and r.revision=ref.pin))
            order by a.id for share of a
            """, ids, references.Select(reference => reference.Pin).ToArray(), actor.Id);
        int verified = 0;
        await using (var rows = await check.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct)) verified++;
        }
        if (verified != references.Length || await ArchivedArticleAuthority.AnyLockedArchived(db, tx, ids, ct))
            throw new BusinessException(Rejection.NotFound, "Canvas reference is unavailable.");
        if (requireResolved)
            await CanvasReferenceStore.ValidateLockedAnchors(db, tx, nodes, ct);
    }

    private async Task<List<CanvasNode>> ReadNodes(Guid id, int offset, int limit, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, $"""
            select {Node} from public.canvas_node where canvas_id=$1 order by id limit $2 offset $3
            """, id, limit, offset);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var result = new List<CanvasNode>();
        while (await rows.ReadAsync(ct))
        {
            var geometry = new CanvasGeometry(rows.GetInt32(2), rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5));
            result.Add(new(rows.GetGuid(0), (CanvasNodeKind)rows.GetInt32(1), geometry,
                rows.IsDBNull(6) ? null : rows.GetInt32(6), rows.IsDBNull(7) ? null : rows.GetString(7),
                rows.IsDBNull(8) ? null : rows.GetInt64(8), rows.IsDBNull(9) ? null : rows.GetString(9),
                rows.GetFieldValue<Guid[]>(10).ToImmutableArray()));
        }
        return result;
    }

    private async Task<List<CanvasGraphEdge>> ReadEdges(Guid id, int offset, int limit, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, $"""
            select {Edge} from public.canvas_edge where canvas_id=$1 order by sort_order,id limit $2 offset $3
            """, id, limit, offset);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var result = new List<CanvasGraphEdge>();
        while (await rows.ReadAsync(ct)) result.Add(new(rows.GetGuid(0),
            rows.GetBoolean(1) ? CanvasGraphEdgeKind.ExplicitReferenceNote : CanvasGraphEdgeKind.VisualOnly,
            rows.GetGuid(2), rows.GetGuid(3), rows.GetInt32(4), rows.IsDBNull(5) ? null : rows.GetString(5)));
        return result;
    }

    private async Task DeleteIds(Guid id, string sql, Guid[] removed, CancellationToken ct)
    {
        if (removed.Length == 0) return;
        await using var command = Store.Sql(db, tx, sql, id, removed);
        await command.ExecuteNonQueryAsync(ct);
    }

    private async Task DeleteGraph(Guid id, CancellationToken ct)
    {
        await using var edges = Store.Sql(db, tx, "delete from public.canvas_edge where canvas_id=$1", id);
        await edges.ExecuteNonQueryAsync(ct);
        await using var nodes = Store.Sql(db, tx, "delete from public.canvas_node where canvas_id=$1", id);
        await nodes.ExecuteNonQueryAsync(ct);
    }

    private async Task StoreNode(Guid canvas, CanvasNode node, CancellationToken ct)
    {
        var g = node.Geometry;
        await using var upsert = Store.Sql(db, tx, """
            insert into public.canvas_node(canvas_id,id,kind,x,y,width,height,article_id,anchor,pinned_revision,note,member_ids)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            on conflict (canvas_id,id) do update set x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height,
                article_id=excluded.article_id,anchor=excluded.anchor,pinned_revision=excluded.pinned_revision,
                note=excluded.note,member_ids=excluded.member_ids
            """, canvas, node.Id, (int)node.Kind, g.X, g.Y, g.Width, g.Height,
            Optional(NpgsqlDbType.Integer, node.ArticleId), Optional(NpgsqlDbType.Text, node.Anchor),
            Optional(NpgsqlDbType.Bigint, node.PinnedRevision), Optional(NpgsqlDbType.Text, node.Text),
            node.MemberIds.IsDefault ? Array.Empty<Guid>() : node.MemberIds.ToArray());
        await upsert.ExecuteNonQueryAsync(ct);
    }

    private async Task StoreEdge(Guid canvas, CanvasGraphEdge edge, CancellationToken ct)
    {
        await using var upsert = Store.Sql(db, tx, """
            insert into public.canvas_edge(canvas_id,id,source_node_id,target_node_id,explicit_reference,sort_order,label)
            values($1,$2,$3,$4,$5,$6,$7)
            on conflict (canvas_id,id) do update set source_node_id=excluded.source_node_id,target_node_id=excluded.target_node_id,
                explicit_reference=excluded.explicit_reference,sort_order=excluded.sort_order,label=excluded.label
            """, canvas, edge.Id, edge.SourceNodeId, edge.TargetNodeId, edge.Kind == CanvasGraphEdgeKind.ExplicitReferenceNote,
            edge.Order, Optional(NpgsqlDbType.Text, edge.Label));
        await upsert.ExecuteNonQueryAsync(ct);
    }

    private static CanvasGraph Apply(CanvasGraph before, IReadOnlyList<CanvasChangeFrame> changes)
    {
        if (changes.Count == 0) return before;
        return before.Apply(changes.Select<CanvasChangeFrame, CanvasGraphChange>(change => change switch
        {
            CanvasChangeFrame.PutNode(var node) => new CanvasGraphChange.UpsertNode(new(node.Id, (CanvasNodeKind)node.Kind,
                new(node.X, node.Y, node.Width, node.Height), node.ArticleId, node.Anchor, node.PinnedRevision, node.Text,
                node.MemberIds?.ToImmutableArray() ?? [])),
            CanvasChangeFrame.DropNode(var id) => new CanvasGraphChange.RemoveNode(id),
            CanvasChangeFrame.PutEdge(var edge) => new CanvasGraphChange.UpsertEdge(new(edge.Id, (CanvasGraphEdgeKind)edge.Kind,
                edge.SourceNodeId, edge.TargetNodeId, edge.Order, edge.Label)),
            CanvasChangeFrame.DropEdge(var id) => new CanvasGraphChange.RemoveEdge(id),
            _ => throw Invalid("Invalid Canvas graph edit.")
        }).ToArray());
    }

    private static CanvasNodeFrame ToFrame(CanvasNode node)
    {
        var g = node.Geometry;
        return new(node.Id, (int)node.Kind, g.X, g.Y, g.Width, g.Height, node.ArticleId, node.Anchor,
            node.PinnedRevision, node.Text, node.MemberIds);
    }

    private static CanvasEdgeFrame ToFrame(CanvasGraphEdge edge) =>
        new(edge.Id, (int)edge.Kind, edge.SourceNodeId, edge.TargetNodeId, edge.Order, edge.Label);

    private static CanvasGraphReceipt ReadReceipt(NpgsqlDataReader row) => new(row.GetGuid(0), row.GetInt64(1),
        row.GetString(2), new(row.GetInt32(3), row.GetInt32(4), row.GetInt32(5)), row.GetBoolean(6),
        row.GetInt32(7), row.GetInt32(8), row.GetFieldValue<DateTimeOffset>(9));

    private static NpgsqlParameter Optional(NpgsqlDbType type, object? value) => new()
    {
        NpgsqlDbType = type, Value = value ?? DBNull.Value
    };

    private static int NextOffset(CanvasGraphReceipt document, int first, int count) =>
        first + count < document.NodeCount + document.EdgeCount ? first + count : -1;

    private static string Title(string title)
    {
        title = title.Trim();
        int angle = title.IndexOf('<');
        if (title.Length is < 1 or > 128 || title.Any(char.IsControl) ||
            angle >= 0 && title.IndexOf('>', angle + 1) >= 0) throw Invalid("Enter a valid Canvas title.");
        return title;
    }

    private static CanvasViewport Viewport(CanvasViewport value) =>
        value.X is >= -CanvasGeometry.MaxCoordinate and <= CanvasGeometry.MaxCoordinate &&
        value.Y is >= -CanvasGeometry.MaxCoordinate and <= CanvasGeometry.MaxCoordinate && value.Zoom is >= 100 and <= 4000
            ? value : throw Invalid("Invalid Canvas viewport.");

    private static BusinessException Missing() => new(Rejection.NotFound, "Canvas document is unavailable.");
    private static BusinessException Conflict() => new(Rejection.Conflict, "This Canvas document changed or reached its storage limit.");
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
