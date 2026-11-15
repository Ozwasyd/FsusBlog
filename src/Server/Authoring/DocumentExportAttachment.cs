using System.Globalization;
using System.Net;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record DocumentExportAttachment(string Name, MediaFormat Format, int Width, int Height, byte[] Bytes, byte[]? VerifiedDigest = null)
{
    private const int MaximumBytes = 512 * 1024;

    internal static bool PrivateTransport(HttpContext ctx) =>
        ctx.Request.IsHttps || ctx.Connection.RemoteIpAddress is { } peer && IPAddress.IsLoopback(peer);

    internal static Guid? ReadSelection(HttpContext ctx, bool allowed) =>
        ReadSelections(ctx, allowed ? 1 : 0) is [var asset] ? asset : null;

    internal static Guid[] ReadSelections(HttpContext ctx, int limit)
    {
        if (!ctx.Request.Headers.TryGetValue(WireHeaders.HtmlExportAttachment, out var values)) return [];
        if (values.Count != 1 || values[0] is not { } text || text.Length > limit * 37 - 1) throw InvalidSelection();
        var entries = text.Split(',');
        if (entries.Length > limit) throw InvalidSelection();
        var ids = new Guid[entries.Length];
        for (var index = 0; index < entries.Length; index++)
            if (!Guid.TryParseExact(entries[index], "D", out ids[index]) || ids[index] == Guid.Empty ||
                ids[index].ToString("D") != entries[index] || ids.AsSpan(0, index).Contains(ids[index]))
                throw InvalidSelection();
        return ids;
    }

    private static BusinessException InvalidSelection() =>
        new(Rejection.Invalid, "Select distinct saved images within the document format limit.");

    internal static async Task<DocumentExportAttachment[]> ReadAll(NpgsqlConnection db, NpgsqlTransaction tx, MediaFiles? files,
        Guid owner, int article, long revision, Guid[] assets, CancellationToken ct)
    {
        if (files is null) throw ArticleMediaStore.Missing();
        await using var reference = Store.Sql(db, tx, """
            select m.id,m.name,m.format,m.width,m.height,m.length,m.content_hash
            from unnest($3::uuid[]) with ordinality chosen(id,ordinal)
            join public.article_revision_media r on r.asset_id=chosen.id
            join public.private_media m on m.id=r.asset_id
            where r.article_id=$1 and r.revision=$2 and m.owner_id=$4 and m.phase=1
            order by chosen.ordinal for share of m
            """, article, revision, assets, owner);
        var images = new DocumentExportAttachment[assets.Length];
        var size = 0;
        await using var row = await reference.ExecuteReaderAsync(ct);
        for (var index = 0; index < assets.Length; index++)
        {
            var asset = assets[index];
            if (!await row.ReadAsync(ct) || row.GetGuid(0) != asset) throw ArticleMediaStore.Missing();
            var format = (MediaFormat)row.GetInt16(2);
            var width = row.GetInt32(3);
            var height = row.GetInt32(4);
            var length = row.GetInt32(5);
            var digest = row.GetFieldValue<byte[]>(6);
            if (length > MaximumBytes)
                throw new BusinessException(Rejection.Invalid, "The selected image exceeds the 512 KiB limit.");
            if (length < 1 || digest.Length != 32 || width < 1 || height < 1) throw new PublicUnavailableException();
            byte[]? bytes;
            try { bytes = await files.Read(asset, length, digest, ct); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new PublicUnavailableException(); }
            if (bytes is null || !PublishedArticleImage.MatchesFormat(bytes, (int)format)) throw new PublicUnavailableException();
            size += bytes.Length;
            if (size > MaximumBytes)
                throw new BusinessException(Rejection.Invalid, "The selected images exceed the combined 512 KiB limit.");
            images[index] = new(row.GetString(1), format, width, height, bytes, digest);
        }
        return images;
    }

    internal string ContentType => MediaImage.ContentType(Format);

    internal string Figure(string source, bool xhtml)
    {
        // The caller provides either the verified data URI or a fixed local package path.
        var alt = HtmlEncoder.Default.Encode(Name);
        return string.Create(CultureInfo.InvariantCulture,
            $"<figure><img src=\"{source}\" alt=\"{alt}\" width=\"{Width}\" height=\"{Height}\"{(xhtml ? " /" : "")}></figure>");
    }
}
