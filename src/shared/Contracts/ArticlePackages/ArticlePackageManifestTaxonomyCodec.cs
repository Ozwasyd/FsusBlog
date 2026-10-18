using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Closed explicit taxonomy projection and exact source binding, without taxonomy store access.</summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const int MaxTaxonomyTags = 32;
    public const int MaxTaxonomyJsonBytes = 256 * 1024;
    public const string TaxonomyDigestDomain = "fsusblog.article-package.manifest-taxonomy-candidate.v1";

    public static ArticlePackageManifestCandidateResult TryCreateTaxonomyCandidate(
        ArticlePackageManifestTaxonomyInput? input,
        out ArticlePackageManifestTaxonomyCandidate? candidate)
    {
        candidate = null;
        if (input?.Article is null || input.Category is null || input.SourceCategoryId <= 0)
        {
            return Invalid("article_package_manifest_taxonomy_shape_invalid");
        }
        try
        {
            if (!TryCopyTaxonomyIds(input.SourceTagIds, out int[] sourceIds)
                || !TryCopyMetadataRows(input.Tags, MaxTaxonomyTags, out ArticlePackageManifestTaxonomyEntry[] tags))
            {
                return Invalid("article_package_manifest_taxonomy_collection_invalid");
            }
            if (!TryCreateCandidate([input.Article], out _).IsValid
                || !ValidTaxonomyEntry(input.Category, ArticlePackageIdentityKind.Category)
                || input.Category.SourceId != input.SourceCategoryId || tags.Length != sourceIds.Length)
            {
                return Invalid("article_package_manifest_taxonomy_shape_invalid");
            }
            var declared = new HashSet<int>(sourceIds);
            var actual = new HashSet<int>();
            var portable = new HashSet<ArticlePackageIdentity>();
            if (declared.Count != sourceIds.Length)
            {
                return Invalid("article_package_manifest_taxonomy_duplicate");
            }
            foreach (ArticlePackageManifestTaxonomyEntry tag in tags)
            {
                if (!ValidTaxonomyEntry(tag, ArticlePackageIdentityKind.Tag) || !declared.Contains(tag.SourceId))
                {
                    return Invalid("article_package_manifest_taxonomy_mapping_mismatch");
                }
                if (!actual.Add(tag.SourceId) || !portable.Add(tag.PortableIdentity))
                {
                    return Invalid("article_package_manifest_taxonomy_duplicate");
                }
            }
            Array.Sort(sourceIds);
            Array.Sort(tags, static (left, right) => string.CompareOrdinal(left.PortableIdentity.Value, right.PortableIdentity.Value));
            input = input with
            {
                SourceTagIds = Array.AsReadOnly(sourceIds),
                Tags = Array.AsReadOnly(tags)
            };
            _ = SerializeTaxonomy(input, new string('0', 64));
            byte[] payload = SerializeTaxonomy(input, null);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(s_utf8.GetBytes(TaxonomyDigestDomain + "\0"));
            hash.AppendData(payload);
            candidate = new(input, Convert.ToHexStringLower(hash.GetHashAndReset()));
            return new(true, null);
        }
        catch (EncoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (DocumentBudgetException)
        {
            return Invalid("article_package_manifest_taxonomy_budget_exceeded");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_taxonomy_shape_invalid");
        }
    }

    public static ArticlePackageManifestCandidateResult TryCreateTaxonomySetCandidate(
        IReadOnlyList<ArticlePackageManifestTaxonomyCandidate>? articles,
        out ArticlePackageManifestTaxonomySetCandidate? candidate)
    {
        candidate = null;
        if (!TryCopyMetadataRows(articles, MaxArticles, out ArticlePackageManifestTaxonomyCandidate[] held) || held.Length == 0)
        {
            return Invalid("article_package_manifest_taxonomy_collection_invalid");
        }
        var sourceArticles = new HashSet<int>();
        var portableArticles = new HashSet<ArticlePackageIdentity>();
        var sourcePairs = new Dictionary<(ArticlePackageIdentityKind, int), ArticlePackageManifestTaxonomyEntry>();
        var portablePairs = new Dictionary<ArticlePackageIdentity, ArticlePackageManifestTaxonomyEntry>();
        string? site = null;
        long bytes = 0;
        for (int index = 0; index < held.Length; index++)
        {
            ArticlePackageManifestTaxonomyCandidate article = held[index];
            ArticlePackageManifestCandidateResult check = TryCreateTaxonomyCandidate(article.Input, out var owned);
            if (!check.IsValid || article.ComponentDigest != owned!.ComponentDigest)
            {
                return Invalid("article_package_manifest_taxonomy_binding_mismatch");
            }
            held[index] = owned;
            ArticlePackageManifestArticle manifest = owned.Input.Article;
            site ??= manifest.Source.SiteScope;
            if (site != manifest.Source.SiteScope || !sourceArticles.Add(manifest.Source.ArticleId)
                || !portableArticles.Add(manifest.PortableArticle))
            {
                return Invalid("article_package_manifest_taxonomy_set_mismatch");
            }
            bytes += WriteTaxonomyCandidate(owned).Length;
            if (bytes > MaxJsonBytes)
            {
                return Invalid("article_package_manifest_taxonomy_budget_exceeded");
            }
            if (!BindGlobalTaxonomyEntry(owned.Input.Category, sourcePairs, portablePairs))
            {
                return Invalid("article_package_manifest_taxonomy_set_mismatch");
            }
            foreach (ArticlePackageManifestTaxonomyEntry tag in owned.Input.Tags)
            {
                if (!BindGlobalTaxonomyEntry(tag, sourcePairs, portablePairs))
                {
                    return Invalid("article_package_manifest_taxonomy_set_mismatch");
                }
            }
        }
        Array.Sort(held, static (left, right) => string.CompareOrdinal(left.Input.Article.PortableArticle.Value, right.Input.Article.PortableArticle.Value));
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var writer = new DigestWriter(hash);
        writer.Add("fsusblog.article-package.manifest-taxonomy-set-candidate.v1");
        writer.Add(held.Length);
        foreach (ArticlePackageManifestTaxonomyCandidate article in held)
        {
            writer.Add(article.Input.Article.PortableArticle.Value!);
            writer.Add(article.ComponentDigest);
        }
        candidate = new(held, Convert.ToHexStringLower(hash.GetHashAndReset()));
        return new(true, null);
    }

    private static bool BindGlobalTaxonomyEntry(
        ArticlePackageManifestTaxonomyEntry entry,
        Dictionary<(ArticlePackageIdentityKind, int), ArticlePackageManifestTaxonomyEntry> sources,
        Dictionary<ArticlePackageIdentity, ArticlePackageManifestTaxonomyEntry> portables)
    {
        var key = (entry.PortableIdentity.Kind, entry.SourceId);
        if (sources.TryGetValue(key, out var source) && source != entry
            || portables.TryGetValue(entry.PortableIdentity, out var portable) && portable != entry)
        {
            return false;
        }
        sources[key] = entry;
        portables[entry.PortableIdentity] = entry;
        return true;
    }

    /// <summary>Recomputes the canonical source hash and verifies actual raw bytes; still no persisted observation.</summary>
    public static ArticlePackageManifestCandidateResult TryBindTaxonomyCandidate(
        ArticlePackageManifestTaxonomyCandidate? candidate,
        ArticleCanonicalInput? source,
        ReadOnlySpan<byte> sourceBytes,
        out ArticlePackageManifestTaxonomyCandidate? rebound)
    {
        rebound = null;
        if (candidate is null || source is null || source.Title is null || source.MarkdownContent is null
            || source.MarkdownContent.Length > ArticlePackageSourceBytes.MaximumByteLength
            || sourceBytes.Length > ArticlePackageSourceBytes.MaximumByteLength)
        {
            return Invalid("article_package_manifest_taxonomy_source_mismatch");
        }
        try
        {
            if (!TryCreateTaxonomyCandidate(candidate.Input, out var checkedCandidate).IsValid
                || candidate.ComponentDigest != checkedCandidate!.ComponentDigest
                || !TryCopyTaxonomyIds(source.TagIds, out int[] tags))
            {
                return Invalid("article_package_manifest_taxonomy_source_mismatch");
            }
            Array.Sort(tags);
            // Freeze the caller collection before canonical hashing: callback-induced drift cannot change the observed set.
            source = source with
            {
                TagIds = Array.AsReadOnly(tags)
            };
            ArticlePackageManifestTaxonomyInput input = candidate.Input;
            ArticlePackageManifestSource coordinate = input.Article.Source;
            if (tags.Distinct().Count() != tags.Length || !tags.SequenceEqual(input.SourceTagIds)
                || source.CategoryId != input.SourceCategoryId || source.ArticleId != coordinate.ArticleId
                || source.ArticleRevisionId != coordinate.ArticleRevisionId || source.RevisionNo != coordinate.RevisionNo
                || coordinate.DraftId.HasValue || coordinate.PublicationId.HasValue
                || source.Title != input.Article.Title || source.Summary != input.Article.Summary
                || source.Status != input.Article.Lifecycle.Status || source.PublishedAt != input.Article.Lifecycle.PublishedAt
                || source.ScheduledPublishAt != input.Article.Lifecycle.ScheduledPublishAt
                || source.PublishedAt is { Kind: not DateTimeKind.Utc } || source.ScheduledPublishAt is { Kind: not DateTimeKind.Utc }
                || !MetadataText(source.PublicRouteKey, 2048) || !MetadataText(source.CoverImageUrl, 512)
                || s_utf8.GetByteCount(source.MarkdownContent) > ArticlePackageSourceBytes.MaximumByteLength
                || ArticleCanonicalHashV1.ComputeHashHex(source) != coordinate.CanonicalHash)
            {
                return Invalid("article_package_manifest_taxonomy_source_mismatch");
            }
            byte[] ownedBytes = sourceBytes.ToArray();
            ArticlePackageByteValidationResult raw = ArticlePackageSourceBytes.Inspect(ownedBytes, out var metadata);
            if (!raw.IsValid || metadata != input.Article.SourceBytes)
            {
                return Invalid("article_package_manifest_taxonomy_source_mismatch");
            }
            ReadOnlySpan<byte> markdown = metadata!.HasUtf8Bom ? ownedBytes.AsSpan(3) : ownedBytes.AsSpan();
            if (s_utf8.GetString(markdown) != source.MarkdownContent)
            {
                return Invalid("article_package_manifest_taxonomy_source_mismatch");
            }
            rebound = checkedCandidate;
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_taxonomy_source_mismatch");
        }
    }

    public static byte[] WriteTaxonomyCandidate(ArticlePackageManifestTaxonomyCandidate candidate)
    {
        if (candidate is null || !TryCreateTaxonomyCandidate(candidate.Input, out var checkedCandidate).IsValid
            || candidate.ComponentDigest != checkedCandidate!.ComponentDigest)
        {
            throw new ArgumentException("article_package_manifest_taxonomy_candidate_invalid");
        }
        return SerializeTaxonomy(candidate.Input, candidate.ComponentDigest);
    }

    public static ArticlePackageManifestCandidateResult TryParseTaxonomyCandidate(
        ReadOnlySpan<byte> json,
        out ArticlePackageManifestTaxonomyCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxTaxonomyJsonBytes)
        {
            return Invalid("article_package_manifest_taxonomy_budget_exceeded");
        }
        try
        {
            _ = s_utf8.GetCharCount(json);
            if (!HasValidEscapedUnicode(json))
            {
                return Invalid("article_package_manifest_utf8_invalid");
            }
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = MaxReadDepth });
            JsonElement root = document.RootElement;
            ArticlePackageManifestCandidateResult keys = CheckMetadataObjectKeys(root,
                "article", "sourceCategoryId", "sourceTagIds", "category", "tags", "componentDigest");
            if (!keys.IsValid)
            {
                return keys;
            }
            ArticlePackageManifestCandidateResult articleResult = ReadArticle(root.GetProperty("article"), out var article);
            if (!articleResult.IsValid)
            {
                return articleResult;
            }
            JsonElement sourceTags = root.GetProperty("sourceTagIds");
            JsonElement tagRows = root.GetProperty("tags");
            if (!ReadInt(root, "sourceCategoryId", out int categoryId)
                || !ReadString(root, "componentDigest", out string? digest) || !IsDigest(digest)
                || sourceTags.ValueKind != JsonValueKind.Array || sourceTags.GetArrayLength() > MaxTaxonomyTags
                || tagRows.ValueKind != JsonValueKind.Array || tagRows.GetArrayLength() > MaxTaxonomyTags)
            {
                return Invalid("article_package_manifest_taxonomy_shape_invalid");
            }
            ArticlePackageManifestCandidateResult categoryResult = ReadTaxonomyEntry(root.GetProperty("category"), ArticlePackageIdentityKind.Category, out var category);
            if (!categoryResult.IsValid)
            {
                return categoryResult;
            }
            var ids = new int[sourceTags.GetArrayLength()];
            int index = 0;
            foreach (JsonElement id in sourceTags.EnumerateArray())
            {
                if (!id.TryGetInt32(out ids[index++]))
                {
                    return Invalid("article_package_manifest_taxonomy_shape_invalid");
                }
            }
            var tags = new ArticlePackageManifestTaxonomyEntry[tagRows.GetArrayLength()];
            index = 0;
            foreach (JsonElement row in tagRows.EnumerateArray())
            {
                ArticlePackageManifestCandidateResult result = ReadTaxonomyEntry(row, ArticlePackageIdentityKind.Tag, out var tag);
                if (!result.IsValid)
                {
                    return result;
                }
                tags[index++] = tag!;
            }
            ArticlePackageManifestCandidateResult created = TryCreateTaxonomyCandidate(new(article!, categoryId, ids, category!, tags), out var parsed);
            if (!created.IsValid)
            {
                return created;
            }
            if (parsed!.ComponentDigest != digest)
            {
                return Invalid("article_package_manifest_taxonomy_digest_mismatch");
            }
            candidate = parsed;
            return new(true, null);
        }
        catch (DecoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (JsonException)
        {
            return Invalid("article_package_manifest_json_invalid");
        }
        catch (InvalidOperationException)
        {
            return Invalid("article_package_manifest_taxonomy_shape_invalid");
        }
    }

    private static bool ValidTaxonomyEntry(ArticlePackageManifestTaxonomyEntry entry, ArticlePackageIdentityKind kind)
        => entry.SourceId > 0 && entry.PortableIdentity.Kind == kind
            && ArticlePackageIdentity.TryCreate(kind, entry.PortableIdentity.Value, out _).IsValid
            && MetadataText(entry.Name, 128, true) && MetadataText(entry.Description, 500);

    private static bool TryCopyTaxonomyIds(IReadOnlyList<int>? values, out int[] held)
    {
        held = [];
        try
        {
            if (values is null)
            {
                return false;
            }
            int count = values.Count;
            if (count < 0 || count > MaxTaxonomyTags)
            {
                return false;
            }
            var copy = new int[count];
            for (int index = 0; index < count; index++)
            {
                int value = values[index];
                if (value <= 0)
                {
                    return false;
                }
                copy[index] = value;
            }
            held = copy;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static ArticlePackageManifestCandidateResult ReadTaxonomyEntry(JsonElement row, ArticlePackageIdentityKind kind, out ArticlePackageManifestTaxonomyEntry? entry)
    {
        entry = null;
        ArticlePackageManifestCandidateResult keys = CheckMetadataObjectKeys(row, "portableIdentity", "sourceId", "name", "description");
        if (!keys.IsValid)
        {
            return keys;
        }
        if (!ReadString(row, "portableIdentity", out string? identity)
            || !ArticlePackageIdentity.TryCreate(kind, identity, out var portable).IsValid
            || !ReadInt(row, "sourceId", out int id) || !ReadString(row, "name", out string? name)
            || !ReadNullableString(row, "description", out string? description))
        {
            return Invalid("article_package_manifest_taxonomy_shape_invalid");
        }
        entry = new(portable, id, name!, description);
        return new(true, null);
    }

    private static byte[] SerializeTaxonomy(ArticlePackageManifestTaxonomyInput input, string? digest)
    {
        using var stream = new MetadataBudgetStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("article");
            WriteArticle(writer, input.Article);
            writer.WriteNumber("sourceCategoryId", input.SourceCategoryId);
            writer.WriteStartArray("sourceTagIds");
            foreach (int id in input.SourceTagIds)
            {
                writer.WriteNumberValue(id);
            }
            writer.WriteEndArray();
            writer.WritePropertyName("category");
            WriteTaxonomyEntry(writer, input.Category);
            writer.WriteStartArray("tags");
            foreach (ArticlePackageManifestTaxonomyEntry tag in input.Tags)
            {
                WriteTaxonomyEntry(writer, tag);
            }
            writer.WriteEndArray();
            if (digest is not null)
            {
                writer.WriteString("componentDigest", digest);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static void WriteTaxonomyEntry(Utf8JsonWriter writer, ArticlePackageManifestTaxonomyEntry entry)
    {
        writer.WriteStartObject();
        writer.WriteString("portableIdentity", entry.PortableIdentity.Value);
        writer.WriteNumber("sourceId", entry.SourceId);
        writer.WriteString("name", entry.Name);
        writer.WriteString("description", entry.Description);
        writer.WriteEndObject();
    }
}
