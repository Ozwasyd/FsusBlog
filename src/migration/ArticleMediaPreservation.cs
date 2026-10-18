using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

using AngleSharp.Html.Parser;

using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace FsusBlog.Migration;

internal sealed record ArticleMediaSource(long ArticleId, string? CoverUrl, string Markdown, Uri DocumentBase);
internal sealed record ArticleMediaLimits(int Articles, int References, int Files, int MarkdownBytes,
    int UrlCharacters, long MetadataBytes, long FileBytes, long TotalBytes)
{
    public void Validate()
    {
        if (Articles <= 0 || References <= 0 || Files <= 0 || MarkdownBytes <= 0 || UrlCharacters <= 0
            || MetadataBytes <= 0 || FileBytes <= 0 || TotalBytes <= 0)
            throw new ArticleMediaException("invalid_resource_budget");
    }
}

internal enum ArticleMediaReferenceKind
{
    Cover,
    Image,
    Attachment
}
internal sealed record ArticleMediaAlias(long ArticleId, string Url, ArticleMediaReferenceKind Kind, int Offset);
internal sealed record ArticleMediaFile(string RelativePath, long Bytes, string Sha256, ImmutableArray<ArticleMediaAlias> Aliases);
internal sealed record ArticleMediaInventory(string SourceRootIdentity, string SourceDocumentsDigest,
    ImmutableArray<ArticleMediaFile> Files, long TotalBytes, string ManifestDigest);
/// <summary>Exact original plan, source snapshot, media readset and physical destination binding.</summary>
internal sealed record ArticleMediaBinding(Guid RunId, string PlanArtifactSha256, string PlanContentDigest,
    string SourceContentDigest, string ManifestDigest, string SourceRootIdentity, string TargetRootIdentity, string TargetDirectoryName);
internal enum ArticleMediaJournalState
{
    Prepared,
    MediaPublished,
    DatabaseCommitted
}
internal sealed record ArticleMediaPublication(ArticleMediaBinding Binding, string GenerationIdentity);

/// <summary>
/// Original apply/journal-owned durable preparation and publication CAS. Implementations must
/// retain the original exclusive apply ownership across this operation and validate every binding.
/// There is no production default, file journal, synthesized lease or database-commit authority here.
/// </summary>
internal interface IArticleMediaPreservationJournal
{
    Task<ArticleMediaJournalState> RequirePreparedAsync(ArticleMediaBinding binding, CancellationToken token);
    Task RecordPublishedAsync(ArticleMediaPublication publication, ArticleMediaJournalState expected, CancellationToken token);
}

internal sealed class ArticleMediaException(string reason) : Exception(reason);

internal static class ArticleMediaPreservation
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly MarkdownPipeline s_pipeline = new MarkdownPipelineBuilder()
        .UsePipeTables().UseFootnotes().UseEmphasisExtras().UseTaskLists().UseAutoLinks().Build();

    public static async Task<ArticleMediaInventory> InventoryAsync(IAsyncEnumerable<ArticleMediaSource> articles,
        string sourceRoot, Uri trustedOrigin, string publicPathPrefix, ArticleMediaLimits limits, CancellationToken token)
    {
        limits.Validate();
        ValidateOrigin(trustedOrigin);
        ValidatePrefix(publicPathPrefix);
        using var root = ArticleMediaDirectory.Open(sourceRoot, writable: false);
        using var documents = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var paths = new SortedDictionary<string, List<ArticleMediaAlias>>(StringComparer.Ordinal);
        var articleIds = new HashSet<long>();
        long metadataBytes = 0;
        var references = 0;
        await foreach (var article in articles.WithCancellation(token))
        {
            if (article.ArticleId <= 0 || !articleIds.Add(article.ArticleId) || articleIds.Count > limits.Articles)
                throw new ArticleMediaException("article_identity_or_budget");
            ValidateOrigin(article.DocumentBase);
            if (!SameOrigin(article.DocumentBase, trustedOrigin))
                throw new ArticleMediaException("untrusted_document_base");
            if (s_strictUtf8.GetByteCount(article.Markdown) > limits.MarkdownBytes)
                throw new ArticleMediaException("markdown_budget");
            AppendSourceDocument(documents, article);
            foreach (var reference in ParseReferences(article))
            {
                token.ThrowIfCancellationRequested();
                if (++references > limits.References || reference.Url.Length > limits.UrlCharacters)
                    throw new ArticleMediaException("reference_budget");
                var path = ResolveLocal(reference.Url, article.DocumentBase, trustedOrigin, publicPathPrefix, reference.Kind);
                if (path is null)
                    continue;
                metadataBytes = checked(metadataBytes + s_strictUtf8.GetByteCount(path) + s_strictUtf8.GetByteCount(reference.Url) + 64);
                if (metadataBytes > limits.MetadataBytes)
                    throw new ArticleMediaException("metadata_budget");
                if (!paths.TryGetValue(path, out var aliases))
                {
                    if (paths.Count >= limits.Files)
                        throw new ArticleMediaException("file_count_budget");
                    aliases = [];
                    paths.Add(path, aliases);
                }
                aliases.Add(reference);
            }
        }
        var files = ImmutableArray.CreateBuilder<ArticleMediaFile>(paths.Count);
        long total = 0;
        foreach (var pair in paths)
        {
            var evidence = await root.HashFileAsync(pair.Key, limits.FileBytes, token);
            total = checked(total + evidence.Bytes);
            if (total > limits.TotalBytes)
                throw new ArticleMediaException("total_byte_budget");
            files.Add(new(pair.Key, evidence.Bytes, evidence.Sha256, pair.Value.ToImmutableArray()));
        }
        var inventory = new ArticleMediaInventory(root.Identity, Hex(documents.GetHashAndReset()), files.ToImmutable(), total, "");
        inventory = inventory with
        {
            ManifestDigest = ComputeManifestDigest(inventory)
        };
        ValidateInventory(inventory, limits);
        return inventory;
    }

    public static async Task<ArticleMediaPublication> StageAndPublishAsync(ArticleMediaInventory inventory,
        string sourceRoot, string targetParent, string targetDirectoryName, ArticleMediaBinding binding,
        ArticleMediaLimits limits, IArticleMediaPreservationJournal journal, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(journal);
        limits.Validate();
        ValidateInventory(inventory, limits);
        ValidateBinding(binding, inventory);
        ArticleMediaDirectory.ValidateSegment(targetDirectoryName);
        if (targetDirectoryName != binding.TargetDirectoryName || targetDirectoryName.StartsWith(".media-", StringComparison.Ordinal))
            throw new ArticleMediaException("target_generation_binding");
        using var source = ArticleMediaDirectory.Open(sourceRoot, writable: false);
        using var parent = ArticleMediaDirectory.Open(targetParent, writable: true);
        if (source.Identity != inventory.SourceRootIdentity || parent.Identity != binding.TargetRootIdentity
            || source.Overlaps(parent))
            throw new ArticleMediaException("physical_root_binding");
        var state = await journal.RequirePreparedAsync(binding, token);
        if (!Enum.IsDefined(state))
            throw new ArticleMediaException("invalid_journal_state");
        // Read the existing published generation first: recovery must not create a second generation.
        using var published = parent.TryOpenDirectory(targetDirectoryName);
        if (published is not null)
        {
            await published.VerifyAsync(inventory.Files, limits.FileBytes, limits.MetadataBytes, token);
            await VerifySourceAsync(source, inventory, limits, token);
            var existing = new ArticleMediaPublication(binding, published.Identity);
            if (state == ArticleMediaJournalState.Prepared)
                await journal.RecordPublishedAsync(existing, state, token);
            return existing;
        }
        if (state != ArticleMediaJournalState.Prepared)
            throw new ArticleMediaException("published_generation_missing");
        var stageName = ".media-" + binding.RunId.ToString("N") + ".tmp";
        using (var stage = parent.OpenOrCreateDirectory(stageName))
        {
            foreach (var file in inventory.Files)
                await stage.CopyVerifiedAsync(source, file, limits.FileBytes, token);
            await stage.VerifyAsync(inventory.Files, limits.FileBytes, limits.MetadataBytes, token);
            await VerifySourceAsync(source, inventory, limits, token);
        }
        // A crash after this rename but before journal CAS is recovered through the existing branch above.
        parent.Publish(stageName, targetDirectoryName);
        using var generation = parent.TryOpenDirectory(targetDirectoryName)
            ?? throw new ArticleMediaException("published_generation_missing");
        await generation.VerifyAsync(inventory.Files, limits.FileBytes, limits.MetadataBytes, token);
        var publication = new ArticleMediaPublication(binding, generation.Identity);
        await journal.RecordPublishedAsync(publication, ArticleMediaJournalState.Prepared, token);
        // This is physical publication evidence, never a database commit or an apply step proof.
        return publication;
    }

    internal static IEnumerable<ArticleMediaAlias> ParseReferences(ArticleMediaSource source)
    {
        if (!string.IsNullOrEmpty(source.CoverUrl))
            yield return new(source.ArticleId, source.CoverUrl, ArticleMediaReferenceKind.Cover, -1);
        var ast = Markdown.Parse(source.Markdown, s_pipeline);
        foreach (var link in ast.Descendants<LinkInline>())
            if (!string.IsNullOrEmpty(link.Url))
                yield return new(source.ArticleId, link.Url, link.IsImage ? ArticleMediaReferenceKind.Image : ArticleMediaReferenceKind.Attachment, link.Span.Start);
        foreach (var html in ast.Descendants<HtmlBlock>())
            foreach (var reference in ParseHtml(source.ArticleId, html.Lines.ToString(), html.Span.Start))
                yield return reference;
        foreach (var html in ast.Descendants<HtmlInline>())
            foreach (var reference in ParseHtml(source.ArticleId, html.Tag, html.Span.Start))
                yield return reference;
    }

    internal static void AppendSourceDocument(IncrementalHash hash, ArticleMediaSource source)
    {
        Append(hash, source.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Append(hash, source.Markdown);
        Append(hash, source.CoverUrl);
        Append(hash, source.DocumentBase.AbsoluteUri);
    }

    private static IEnumerable<ArticleMediaAlias> ParseHtml(long articleId, string html, int offset)
    {
        // Parse source HTML without scripting, requests or rendering. The public renderer escapes HTML;
        // conservative inventory still preserves parseable references in the original stored source.
        using var document = new HtmlParser(new HtmlParserOptions { IsScripting = false }).ParseDocument(html);
        foreach (var element in document.All)
        {
            var attribute = element.LocalName switch
            {
                "img" or "source" or "audio" or "video" or "embed" => "src",
                "object" => "data",
                "a" => "href",
                _ => null
            };
            if (attribute is not null && element.GetAttribute(attribute) is { Length: > 0 } url)
                yield return new(articleId, url, element.LocalName == "a" ? ArticleMediaReferenceKind.Attachment : ArticleMediaReferenceKind.Image, offset);
            if (element.LocalName == "video" && element.GetAttribute("poster") is { Length: > 0 } poster)
                yield return new(articleId, poster, ArticleMediaReferenceKind.Image, offset);
            if ((element.LocalName is "img" or "source") && element.GetAttribute("srcset") is { Length: > 0 } srcset)
                foreach (var candidate in ParseSourceSetUrls(srcset))
                    yield return new(articleId, candidate, ArticleMediaReferenceKind.Image, offset);
        }
    }

    private static IEnumerable<string> ParseSourceSetUrls(string input)
    {
        // HTML srcset URL/descriptor tokenizer: a comma inside a URL (notably data:) is
        // not a separator. Preserve every candidate conservatively, independent of viewport.
        // Descriptors select rendering, never authorize omission of a source media file.
        var position = 0;
        while (position < input.Length)
        {
            while (position < input.Length && (AsciiSpace(input[position]) || input[position] == ','))
                position++;
            var start = position;
            while (position < input.Length && !AsciiSpace(input[position]))
                position++;
            if (start == position)
                yield break;
            var url = input[start..position];
            if (url.EndsWith(','))
            {
                url = url.TrimEnd(',');
                if (url.Length != 0)
                    yield return url;
                continue;
            }
            yield return url;
            var inParentheses = false;
            while (position < input.Length)
            {
                var current = input[position++];
                if (current == '(')
                    inParentheses = true;
                else if (current == ')')
                    inParentheses = false;
                else if (current == ',' && !inParentheses)
                    break;
            }
        }
    }
    private static bool AsciiSpace(char value) => value is '\t' or '\n' or '\f' or '\r' or ' ';

    private static async Task VerifySourceAsync(ArticleMediaDirectory source, ArticleMediaInventory inventory, ArticleMediaLimits limits, CancellationToken token)
    {
        foreach (var file in inventory.Files)
        {
            var actual = await source.HashFileAsync(file.RelativePath, limits.FileBytes, token);
            if (actual.Bytes != file.Bytes || actual.Sha256 != file.Sha256)
                throw new ArticleMediaException("source_file_changed");
        }
    }

    internal static string? ResolveLocal(string raw, Uri documentBase, Uri origin, string prefix, ArticleMediaReferenceKind kind)
    {
        ValidatePrefix(prefix);
        if (raw.Length == 0 || raw.Any(c => char.IsControl(c) || c == '\\') || raw.StartsWith("//", StringComparison.Ordinal))
            throw new ArticleMediaException("unsafe_media_url");
        // Validate the unnormalised path first: Uri must not erase traversal or encoded separators.
        var beforeQuery = raw.Split(['?', '#'], 2)[0];
        Uri? absolute = null;
        var colon = raw.IndexOf(':');
        var firstSlash = raw.IndexOf('/');
        if (colon >= 0 && (firstSlash < 0 || colon < firstSlash))
        {
            if (!Uri.TryCreate(raw, UriKind.Absolute, out absolute))
                throw new ArticleMediaException("invalid_media_url");
            if (absolute.Scheme is not ("http" or "https"))
                return null;
            if (absolute.UserInfo.Length != 0)
            {
                throw new ArticleMediaException("unsafe_media_url_userinfo");
            }
        }
        var pathText = beforeQuery;
        if (absolute is not null && (absolute.Scheme is "http" or "https"))
        {
            if (!SameOrigin(absolute, origin))
                return null;
            var authorityEnd = beforeQuery.IndexOf('/', beforeQuery.IndexOf("://", StringComparison.Ordinal) + 3);
            pathText = authorityEnd < 0 ? "/" : beforeQuery[authorityEnd..];
        }
        var decoded = DecodePath(pathText);
        if (decoded.Split('/').Any(segment => segment == ".."))
            throw new ArticleMediaException("media_path_traversal");
        if (!Uri.TryCreate(documentBase, raw, out var resolved))
            throw new ArticleMediaException("invalid_media_url");
        if (!SameOrigin(resolved, origin))
            return null;
        var path = DecodePath(resolved.GetComponents(UriComponents.Path, UriFormat.UriEscaped));
        path = "/" + path.TrimStart('/');
        if (!path.StartsWith(prefix, StringComparison.Ordinal))
        {
            if (kind == ArticleMediaReferenceKind.Attachment)
                return null; // Ordinary article/navigation links are not media.
            throw new ArticleMediaException("local_media_root_unmapped");
        }
        var relative = path[prefix.Length..];
        ArticleMediaDirectory.ValidateRelativePath(relative);
        return relative;
    }

    private static string DecodePath(string path)
    {
        var result = new StringBuilder();
        for (var i = 0; i < path.Length;)
        {
            if (path[i] != '%')
            {
                result.Append(path[i++]);
                continue;
            }
            var bytes = new List<byte>();
            while (i < path.Length && path[i] == '%')
            {
                if (i + 2 >= path.Length || !byte.TryParse(path.AsSpan(i + 1, 2), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var value))
                    throw new ArticleMediaException("invalid_url_encoding");
                if (value is 0 or 47 or 92 or 37)
                    throw new ArticleMediaException("ambiguous_url_encoding");
                bytes.Add(value);
                i += 3;
            }
            try
            {
                result.Append(s_strictUtf8.GetString(bytes.ToArray()));
            }
            catch (DecoderFallbackException)
            {
                throw new ArticleMediaException("invalid_url_encoding");
            }
        }
        return result.ToString();
    }

    private static void ValidateOrigin(Uri uri)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length != 0)
            throw new ArticleMediaException("invalid_origin");
    }
    private static bool SameOrigin(Uri left, Uri right) => left.Scheme == right.Scheme
        && string.Equals(left.IdnHost, right.IdnHost, StringComparison.OrdinalIgnoreCase) && left.Port == right.Port && left.UserInfo.Length == 0;
    private static void ValidatePrefix(string prefix)
    {
        if (!prefix.StartsWith('/') || !prefix.EndsWith('/') || prefix.Length < 3)
            throw new ArticleMediaException("invalid_media_prefix");
        ArticleMediaDirectory.ValidateRelativePath(prefix[1..^1]);
    }
    internal static string ComputeManifestDigest(ArticleMediaInventory inventory)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, "article-media-manifest-v1");
        Append(hash, inventory.SourceRootIdentity);
        Append(hash, inventory.SourceDocumentsDigest);
        Append(hash, inventory.Files.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
        foreach (var file in inventory.Files)
        {
            Append(hash, file.RelativePath);
            Append(hash, file.Bytes.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Append(hash, file.Sha256);
            Append(hash, file.Aliases.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
            foreach (var alias in file.Aliases)
            {
                Append(hash, alias.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                Append(hash, alias.Url);
                Append(hash, ((int)alias.Kind).ToString(System.Globalization.CultureInfo.InvariantCulture));
                Append(hash, alias.Offset.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return Hex(hash.GetHashAndReset());
    }
    internal static void ValidateInventory(ArticleMediaInventory inventory, ArticleMediaLimits limits)
    {
        if (inventory.Files.IsDefault || inventory.Files.Length > limits.Files || !IsDigest(inventory.SourceDocumentsDigest)
            || inventory.SourceRootIdentity.Length == 0)
            throw new ArticleMediaException("inventory_binding");
        long bytes = 0;
        long metadata = 0;
        var references = 0;
        string? previous = null;
        var articles = new HashSet<long>();
        foreach (var file in inventory.Files)
        {
            ArticleMediaDirectory.ValidateRelativePath(file.RelativePath);
            if (file.Bytes < 0 || file.Bytes > limits.FileBytes || !IsDigest(file.Sha256) || file.Aliases.IsDefaultOrEmpty
                || previous is not null && StringComparer.Ordinal.Compare(previous, file.RelativePath) >= 0)
                throw new ArticleMediaException("inventory_shape");
            previous = file.RelativePath;
            bytes = checked(bytes + file.Bytes);
            foreach (var alias in file.Aliases)
            {
                if (alias.ArticleId <= 0 || !Enum.IsDefined(alias.Kind) || alias.Url.Length > limits.UrlCharacters)
                    throw new ArticleMediaException("inventory_alias");
                articles.Add(alias.ArticleId);
                references++;
                metadata = checked(metadata + s_strictUtf8.GetByteCount(file.RelativePath) + s_strictUtf8.GetByteCount(alias.Url) + 64);
            }
        }
        metadata = checked(metadata + ArticleMediaDirectory.CountDirectoryMetadataBytes(inventory.Files, limits.MetadataBytes));
        if (bytes != inventory.TotalBytes || bytes > limits.TotalBytes || metadata > limits.MetadataBytes || references > limits.References || articles.Count > limits.Articles)
            throw new ArticleMediaException("inventory_budget");
        if (ComputeManifestDigest(inventory) != inventory.ManifestDigest)
            throw new ArticleMediaException("inventory_binding");
    }
    private static void ValidateBinding(ArticleMediaBinding binding, ArticleMediaInventory inventory)
    {
        if (binding.RunId == Guid.Empty || !IsDigest(binding.PlanArtifactSha256) || !IsDigest(binding.PlanContentDigest)
            || !IsDigest(binding.SourceContentDigest) || binding.ManifestDigest != inventory.ManifestDigest
            || binding.SourceRootIdentity != inventory.SourceRootIdentity || binding.TargetRootIdentity.Length == 0)
            throw new ArticleMediaException("prepare_binding");
        ArticleMediaDirectory.ValidateSegment(binding.TargetDirectoryName);
    }
    private static bool IsDigest(string value) => value.Length == 64 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static string Hex(byte[] value) => Convert.ToHexString(value).ToLowerInvariant();
    private static void Append(IncrementalHash hash, string? value)
    {
        // Explicit null/length framing, not concatenation. Markdown bytes remain unchanged.
        Span<byte> prefix = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(prefix, value is null ? -1 : s_strictUtf8.GetByteCount(value));
        hash.AppendData(prefix);
        if (value is not null)
            hash.AppendData(s_strictUtf8.GetBytes(value));
    }
}
