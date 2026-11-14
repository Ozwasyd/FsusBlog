using System.Globalization;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasBundleStore
{
    // Whole revision bodies are needed only for anchor rebinding. Cap distinct sources
    // independently of the graph count and scan only the explicitly stored anchor IDs.
    private const int MaxAnchorRevisions = 64;
    private const long MaxAnchorScanCharacters = 12_800_000;

    internal static CanvasPortableBundle Read(byte[] data)
    {
        try
        {
            return CanvasPortableBundle.Decode(data);
        }
        catch (BusinessException)
        {
            throw Invalid("The Canvas bundle is invalid or exceeds its size limit.");
        }
    }

    internal static CanvasBundlePlan Plan(byte[] data)
    {
        var parsed = Read(data);
        return new(Digest(data), parsed.SourceRevision, parsed.Title, parsed.NodeCount, parsed.EdgeCount,
            parsed.References.Select(reference => new CanvasBundleReference(reference.Slot, (int)reference.Kind,
                reference.RequiresPin, reference.Anchor)).ToArray());
    }

    internal static string Digest(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));

    internal static async Task ValidateAnchors(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyList<CanvasNode> nodes, CancellationToken ct)
    {
        // Caller already checked the current author and locked these article rows in a
        // deterministic order. Group repeated references within a current or pinned coordinate.
        var wanted = nodes.Where(node => node.Kind is CanvasNodeKind.HeadingReference or CanvasNodeKind.BlockReference)
            .GroupBy(node => (Article: node.ArticleId!.Value, Pin: node.PinnedRevision ?? 0))
            .OrderBy(group => group.Key.Article).ThenBy(group => group.Key.Pin).ToArray();
        if (wanted.Length > MaxAnchorRevisions)
            throw Invalid($"The Canvas bundle can reference anchors in at most {MaxAnchorRevisions.ToString(CultureInfo.InvariantCulture)} article revisions.");
        long scanned = 0;
        foreach (var coordinates in wanted)
        {
            ct.ThrowIfCancellationRequested();
            await using var source = Store.Sql(db, tx, """
                select case when octet_length(r.body)<=$3 and char_length(r.body)<=$4 then r.body end
                from public.article a join public.article_revision r
                on r.article_id=a.id and r.revision=coalesce(nullif($2,0),a.revision)
                where a.id=$1
                """, coordinates.Key.Article, coordinates.Key.Pin, WireLimits.BodyBytes, CanvasAnchor.MaxSourceCharacters);
            if (await source.ExecuteScalarAsync(ct) is not string body || body.Length > CanvasAnchor.MaxSourceCharacters)
                throw Missing();
            // A single bundle may point repeatedly to the same anchor. Do not repeat any
            // source work for a duplicate target coordinate when only its slot differs.
            var anchors = coordinates.Select(node => (node.Anchor!, Heading: node.Kind == CanvasNodeKind.HeadingReference))
                .Distinct().ToArray();
            if (anchors.Length > 64)
                throw Invalid("The Canvas bundle can map up to 64 distinct anchors per article revision.");
            scanned += (long)body.Length * anchors.Length;
            if (scanned > MaxAnchorScanCharacters)
                throw Invalid("The Canvas bundle exceeds its source scan budget.");
            foreach (var (anchor, heading) in anchors)
            {
                if (CanvasAnchor.Find(body, anchor, heading, ct).State != CanvasAnchorState.Resolved)
                    throw Missing();
            }
        }
    }

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
    private static BusinessException Missing() => new(Rejection.NotFound, "A Canvas bundle reference is unavailable.");
}
