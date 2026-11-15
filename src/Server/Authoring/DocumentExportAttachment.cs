using System.Globalization;
using System.Net;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record DocumentExportAttachment(string Name, MediaFormat Format, int Width, int Height, byte[] Bytes)
{
    private const int MaximumBytes = 512 * 1024;

    internal static bool PrivateTransport(HttpContext ctx) =>
        ctx.Request.IsHttps || ctx.Connection.RemoteIpAddress is { } peer && IPAddress.IsLoopback(peer);

    internal static Guid? ReadSelection(HttpContext ctx, bool allowed)
    {
        if (!ctx.Request.Headers.TryGetValue(WireHeaders.HtmlExportAttachment, out var values)) return null;
        if (!allowed || values.Count != 1 || values[0] is not { Length: 36 } text ||
            !Guid.TryParseExact(text, "D", out var asset) || asset == Guid.Empty || asset.ToString("D") != text)
            throw new BusinessException(Rejection.Invalid, "Choose one private image for a Word, HTML or EPUB download.");
        return asset;
    }

    internal static async Task<DocumentExportAttachment> Read(NpgsqlConnection db, NpgsqlTransaction tx, MediaFiles? files,
        Guid owner, int article, long revision, Guid asset, CancellationToken ct)
    {
        if (files is null) throw ArticleMediaStore.Missing();
        await using var reference = Store.Sql(db, tx, """
            select m.name,m.format,m.width,m.height,m.length,m.content_hash
            from public.article_revision_media r join public.private_media m on m.id=r.asset_id
            where r.article_id=$1 and r.revision=$2 and r.asset_id=$3 and m.owner_id=$4 and m.phase=1
            for share of m
            """, article, revision, asset, owner);
        string name;
        MediaFormat format;
        int width;
        int height;
        int length;
        byte[] digest;
        await using (var row = await reference.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw ArticleMediaStore.Missing();
            name = row.GetString(0);
            format = (MediaFormat)row.GetInt16(1);
            width = row.GetInt32(2);
            height = row.GetInt32(3);
            length = row.GetInt32(4);
            digest = row.GetFieldValue<byte[]>(5);
        }
        if (length > MaximumBytes)
            throw new BusinessException(Rejection.Invalid, "The selected image exceeds the 512 KiB limit.");
        if (length < 1 || digest.Length != 32 || width < 1 || height < 1)
            throw new PublicUnavailableException();
        byte[]? bytes;
        try { bytes = await files.Read(asset, length, digest, ct); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new PublicUnavailableException();
        }
        if (bytes is null || !PublishedArticleImage.MatchesFormat(bytes, (int)format))
            throw new PublicUnavailableException();
        return new(name, format, width, height, bytes);
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
