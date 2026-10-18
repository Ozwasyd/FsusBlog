using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>
/// Closed v1 candidate codec. It validates source shape and finite semantic self-consistency only;
/// actual source binding and all missing package authorities remain independent acceptance gates.
/// </summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const int MaxArticles = 1000;
    public const int MaxJsonBytes = 16 * 1024 * 1024;
    public const string DigestDomain = "fsusblog.article-package.manifest-candidate.v1";

    private const int MaxSiteScopeCharacters = 128;
    // Parsing can observe a rejected authority's empty container before closed-schema validation.
    private const int MaxReadDepth = 8;
    private const string UtcFormat = "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'";
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    public static ArticlePackageManifestCandidateResult TryCreateCandidate(
        IReadOnlyList<ArticlePackageManifestArticle>? articles,
        out ArticlePackageManifestCandidate? candidate)
    {
        candidate = null;
        if (articles is null)
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        int count = articles.Count;
        if (count is < 1 or > MaxArticles)
        {
            return Invalid("article_package_manifest_article_budget_exceeded");
        }
        if (!SupportedVersions(1, 1, 1))
        {
            return Invalid("article_package_manifest_version_unsupported");
        }
        try
        {
            var held = new ArticlePackageManifestArticle[count];
            long textCodeUnits = 0;
            for (int index = 0; index < count; index++)
            {
                ArticlePackageManifestArticle article = articles[index];
                if (article is null || article.Source is null || article.Title is null)
                {
                    return Invalid("article_package_manifest_shape_invalid");
                }
                long nextText = article.Title.Length + (long)(article.Summary?.Length ?? 0) + (article.Source.SiteScope?.Length ?? 0);
                if (nextText > MaxJsonBytes - textCodeUnits)
                {
                    return Invalid("article_package_manifest_document_budget_exceeded");
                }
                textCodeUnits += nextText;
                held[index] = article;
            }
            var portableIds = new HashSet<string>(StringComparer.Ordinal);
            var sourceIds = new HashSet<int>();
            foreach (ArticlePackageManifestArticle article in held)
            {
                if (!IsValidArticle(article))
                {
                    return Invalid("article_package_manifest_shape_invalid");
                }
                if (!portableIds.Add(article.PortableArticle.Value!) || !sourceIds.Add(article.Source.ArticleId))
                {
                    return Invalid("article_package_manifest_article_duplicate");
                }
            }
            Array.Sort(held, static (left, right) => string.CompareOrdinal(left.PortableArticle.Value, right.PortableArticle.Value));
            using var countStream = new BudgetStream();
            using (var writer = new Utf8JsonWriter(countStream))
            {
                WriteDocument(writer, held, new string('0', 64));
            }
            string digest = ComputeDigest(held);
            candidate = new ArticlePackageManifestCandidate(held, digest);
            return new(true, null);
        }
        catch (EncoderFallbackException)
        {
            return Invalid("article_package_manifest_utf8_invalid");
        }
        catch (DocumentBudgetException)
        {
            return Invalid("article_package_manifest_document_budget_exceeded");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
    }

    public static ArticlePackageManifestCandidateResult TryParseCandidate(
        ReadOnlySpan<byte> json,
        out ArticlePackageManifestCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxJsonBytes)
        {
            return Invalid("article_package_manifest_document_budget_exceeded");
        }
        try
        {
            _ = s_utf8.GetCharCount(json);
            if (!HasValidEscapedUnicode(json))
            {
                return Invalid("article_package_manifest_utf8_invalid");
            }
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions
            {
                MaxDepth = MaxReadDepth,
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow
            });
            JsonElement root = document.RootElement;
            ArticlePackageManifestCandidateResult keys = CheckKeys(root,
                "schemaVersion", "canonicalHashVersion", "propertySchemaVersion", "articles", "semanticDigest");
            if (!keys.IsValid)
            {
                return keys;
            }
            if (!ReadInt(root, "schemaVersion", out int schemaVersion)
                || !ReadInt(root, "canonicalHashVersion", out int canonicalVersion)
                || !ReadInt(root, "propertySchemaVersion", out int propertyVersion)
                || !SupportedVersions(schemaVersion, canonicalVersion, propertyVersion))
            {
                return Invalid("article_package_manifest_version_unsupported");
            }
            if (!ReadString(root, "semanticDigest", out string? digest) || !IsDigest(digest))
            {
                return Invalid("article_package_manifest_shape_invalid");
            }
            JsonElement articlesElement = root.GetProperty("articles");
            if (articlesElement.ValueKind != JsonValueKind.Array || articlesElement.GetArrayLength() is < 1 or > MaxArticles)
            {
                return Invalid("article_package_manifest_article_budget_exceeded");
            }
            var articles = new ArticlePackageManifestArticle[articlesElement.GetArrayLength()];
            int index = 0;
            foreach (JsonElement row in articlesElement.EnumerateArray())
            {
                ArticlePackageManifestCandidateResult result = ReadArticle(row, out ArticlePackageManifestArticle? article);
                if (!result.IsValid)
                {
                    return result;
                }
                articles[index++] = article!;
            }
            ArticlePackageManifestCandidateResult created = TryCreateCandidate(articles, out ArticlePackageManifestCandidate? parsed);
            if (!created.IsValid)
            {
                return created;
            }
            if (!string.Equals(digest, parsed!.SemanticDigest, StringComparison.Ordinal))
            {
                return Invalid("article_package_manifest_semantic_digest_mismatch");
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
            return Invalid("article_package_manifest_shape_invalid");
        }
    }

    /// <summary>Writes deterministic fixed keys after rechecking the complete finite candidate.</summary>
    public static byte[] WriteCandidate(ArticlePackageManifestCandidate candidate)
    {
        if (candidate is null
            || !SupportedVersions(candidate.SchemaVersion, candidate.CanonicalHashVersion, candidate.PropertySchemaVersion)
            || !TryCreateCandidate(candidate.Articles, out ArticlePackageManifestCandidate? canonical).IsValid
            || canonical!.SemanticDigest != candidate.SemanticDigest)
        {
            throw new ArgumentException("article_package_manifest_candidate_invalid");
        }
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteDocument(writer, candidate.Articles, candidate.SemanticDigest);
        }
        return stream.ToArray();
    }

    private static bool IsValidArticle(ArticlePackageManifestArticle? article)
    {
        if (article is null || article.Source is null || article.SourceBytes is null || article.Lifecycle is null
            || article.PortableArticle.Kind != ArticlePackageIdentityKind.Article
            || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, article.PortableArticle.Value, out _).IsValid
            || !IsDigest(article.TitleSummaryDigest) || !IsDigest(article.PropertySnapshotDigest) || !IsDigest(article.PropertyMappingDigest)
            || article.Title is null || article.Title.Length > ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits
            || article.Summary?.Length > ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits)
        {
            return false;
        }
        ArticlePackageManifestSource source = article.Source;
        if (source.ArticleId <= 0 || source.ArticleRevisionId <= 0 || source.RevisionNo <= 0 || source.PropertyRevision <= 0
            || !IsDigest(source.CanonicalHash) || string.IsNullOrWhiteSpace(source.SiteScope) || source.SiteScope.Length > MaxSiteScopeCharacters
            || source.DraftId.HasValue != source.DraftServerRevision.HasValue
            || source.DraftId is <= 0 || source.DraftServerRevision is <= 0 || source.PublicationId is <= 0
            || source.DraftId.HasValue && source.PublicationId.HasValue)
        {
            return false;
        }
        _ = s_utf8.GetByteCount(article.Title);
        if (article.Summary is not null)
        {
            _ = s_utf8.GetByteCount(article.Summary);
        }
        _ = s_utf8.GetByteCount(source.SiteScope);
        ArticlePackageByteMetadata bytes = article.SourceBytes;
        return BoundedCount(bytes.ByteLength) && IsDigest(bytes.Sha256)
            && BoundedCount(bytes.LfCount) && BoundedCount(bytes.CrLfCount) && BoundedCount(bytes.BareCrCount)
            && BoundedCount(bytes.TrailingSpaceCount) && BoundedCount(bytes.TrailingTabCount)
            && Enum.IsDefined(bytes.FinalNewline)
            && ArticleStatusTransitionPolicy.IsDefined(article.Lifecycle.Status)
            && IsUtc(article.Lifecycle.PublishedAt) && IsUtc(article.Lifecycle.ScheduledPublishAt);
    }

    private static ArticlePackageManifestCandidateResult ReadArticle(JsonElement row, out ArticlePackageManifestArticle? article)
    {
        article = null;
        ArticlePackageManifestCandidateResult keys = CheckKeys(row,
            "portableArticle", "source", "title", "summary", "titleSummaryDigest", "propertySnapshotDigest", "propertyMappingDigest", "sourceBytes", "lifecycle");
        if (!keys.IsValid)
        {
            return keys;
        }
        if (!ReadString(row, "portableArticle", out string? portable)
            || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, portable, out ArticlePackageIdentity identity).IsValid
            || !ReadString(row, "title", out string? title) || !ReadNullableString(row, "summary", out string? summary)
            || !ReadString(row, "titleSummaryDigest", out string? textDigest)
            || !ReadString(row, "propertySnapshotDigest", out string? snapshotDigest)
            || !ReadString(row, "propertyMappingDigest", out string? mappingDigest))
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        ArticlePackageManifestCandidateResult sourceResult = ReadSource(row.GetProperty("source"), out ArticlePackageManifestSource? source);
        if (!sourceResult.IsValid)
        {
            return sourceResult;
        }
        ArticlePackageManifestCandidateResult bytesResult = ReadSourceBytes(row.GetProperty("sourceBytes"), out ArticlePackageByteMetadata? bytes);
        if (!bytesResult.IsValid)
        {
            return bytesResult;
        }
        ArticlePackageManifestCandidateResult lifecycleResult = ReadLifecycle(row.GetProperty("lifecycle"), out ArticlePackageManifestLifecycle? lifecycle);
        if (!lifecycleResult.IsValid)
        {
            return lifecycleResult;
        }
        article = new(identity, source!, title!, summary, textDigest!, snapshotDigest!, mappingDigest!, bytes!, lifecycle!);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult ReadSource(JsonElement value, out ArticlePackageManifestSource? source)
    {
        source = null;
        ArticlePackageManifestCandidateResult keys = CheckKeys(value,
            "articleId", "articleRevisionId", "revisionNo", "canonicalHash", "siteScope", "propertyRevision", "draftId", "draftServerRevision", "publicationId");
        if (!keys.IsValid)
        {
            return keys;
        }
        if (!ReadInt(value, "articleId", out int articleId) || !ReadLong(value, "articleRevisionId", out long revisionId)
            || !ReadInt(value, "revisionNo", out int revisionNo) || !ReadString(value, "canonicalHash", out string? hash)
            || !ReadString(value, "siteScope", out string? scope) || !ReadLong(value, "propertyRevision", out long propertyRevision)
            || !ReadNullableLong(value, "draftId", out long? draft) || !ReadNullableLong(value, "draftServerRevision", out long? draftRevision)
            || !ReadNullableLong(value, "publicationId", out long? publication))
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        source = new(articleId, revisionId, revisionNo, hash!, scope!, propertyRevision, draft, draftRevision, publication);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult ReadSourceBytes(JsonElement value, out ArticlePackageByteMetadata? bytes)
    {
        bytes = null;
        ArticlePackageManifestCandidateResult keys = CheckKeys(value,
            "byteLength", "sha256", "hasUtf8Bom", "lfCount", "crLfCount", "bareCrCount", "finalNewline", "trailingSpaceCount", "trailingTabCount");
        if (!keys.IsValid)
        {
            return keys;
        }
        JsonElement bom = value.GetProperty("hasUtf8Bom");
        if (!ReadInt(value, "byteLength", out int byteLength) || !ReadString(value, "sha256", out string? sha256)
            || bom.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !ReadInt(value, "lfCount", out int lf) || !ReadInt(value, "crLfCount", out int crlf)
            || !ReadInt(value, "bareCrCount", out int cr) || !ReadInt(value, "finalNewline", out int final)
            || final is < 0 or > 3 || !ReadInt(value, "trailingSpaceCount", out int spaces)
            || !ReadInt(value, "trailingTabCount", out int tabs))
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        bytes = new(byteLength, sha256!, bom.GetBoolean(), lf, crlf, cr, (ArticlePackageFinalNewline)final, spaces, tabs);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult ReadLifecycle(JsonElement value, out ArticlePackageManifestLifecycle? lifecycle)
    {
        lifecycle = null;
        ArticlePackageManifestCandidateResult keys = CheckKeys(value, "status", "publishedAt", "scheduledPublishAt");
        if (!keys.IsValid)
        {
            return keys;
        }
        if (!ReadInt(value, "status", out int status) || !ReadDate(value, "publishedAt", out DateTime? published)
            || !ReadDate(value, "scheduledPublishAt", out DateTime? scheduled))
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        lifecycle = new(status, published, scheduled);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult CheckKeys(JsonElement value, params string[] names)
        => CheckClosedKeys(value, names, true);

    private static ArticlePackageManifestCandidateResult CheckClosedKeys(JsonElement value, string[] names, bool denyUnavailableAuthorities)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return Invalid("article_package_manifest_shape_invalid");
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            string? unavailable = property.Name switch
            {
                "assets" => "article_package_manifest_assets_authority_unavailable",
                "syntaxDependencies" => "article_package_manifest_syntax_authority_unavailable",
                "references" => "article_package_manifest_reference_authority_unavailable",
                "rights" => "article_package_manifest_rights_authority_unavailable",
                "responsibility" => "article_package_manifest_responsibility_authority_unavailable",
                "taxonomy" => "article_package_manifest_taxonomy_authority_unavailable",
                "privacy" => "article_package_manifest_privacy_authority_unavailable",
                "sourceMetadata" => "article_package_manifest_source_metadata_authority_unavailable",
                _ => null
            };
            if (unavailable is not null && denyUnavailableAuthorities)
            {
                return Invalid(unavailable);
            }
            if (!names.Contains(property.Name, StringComparer.Ordinal))
            {
                return Invalid("article_package_manifest_unknown_field");
            }
            if (!seen.Add(property.Name))
            {
                return Invalid("article_package_manifest_duplicate_field");
            }
        }
        return seen.Count == names.Length
            ? new(true, null)
            : Invalid("article_package_manifest_missing_field");
    }

    private static bool ReadInt(JsonElement value, string name, out int result)
    {
        result = 0;
        JsonElement field = value.GetProperty(name);
        return field.ValueKind == JsonValueKind.Number && field.TryGetInt32(out result);
    }

    private static bool ReadLong(JsonElement value, string name, out long result)
    {
        result = 0;
        JsonElement field = value.GetProperty(name);
        return field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out result);
    }

    private static bool ReadNullableLong(JsonElement value, string name, out long? result)
    {
        result = null;
        JsonElement field = value.GetProperty(name);
        if (field.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (field.ValueKind != JsonValueKind.Number || !field.TryGetInt64(out long number))
        {
            return false;
        }
        result = number;
        return true;
    }

    private static bool ReadString(JsonElement value, string name, out string? result)
    {
        result = null;
        JsonElement field = value.GetProperty(name);
        if (field.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        result = field.GetString();
        return true;
    }

    private static bool ReadNullableString(JsonElement value, string name, out string? result)
        => value.GetProperty(name).ValueKind == JsonValueKind.Null
            ? SetNull(out result)
            : ReadString(value, name, out result);

    private static bool SetNull(out string? value)
    {
        value = null;
        return true;
    }

    private static bool ReadDate(JsonElement value, string name, out DateTime? result)
    {
        result = null;
        JsonElement field = value.GetProperty(name);
        if (field.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (field.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        string text = field.GetString()!;
        if (text.Length != 28 || !DateTime.TryParseExact(text, UtcFormat, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTime date)
            || date.ToString(UtcFormat, CultureInfo.InvariantCulture) != text)
        {
            return false;
        }
        result = date;
        return true;
    }

    private static bool SupportedVersions(int schema, int canonical, int property)
        => schema == 1 && canonical == 1 && property == 1
            && canonical == ArticleCanonicalHashV1.HashVersion
            && property == ArticlePropertyValueSnapshot.CurrentSchemaVersion;

    private static bool BoundedCount(int count) => count is >= 0 and <= ArticlePackageSourceBytes.MaximumByteLength;

    private static bool IsUtc(DateTime? value) => value is null || value.Value.Kind == DateTimeKind.Utc;

    private static bool IsDigest(string? digest)
        => digest is not null && digest.Length == 64
            && digest.All(character => (character is >= '0' and <= '9') || (character is >= 'a' and <= 'f'));

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);

    private static bool HasValidEscapedUnicode(ReadOnlySpan<byte> json)
    {
        var reader = new Utf8JsonReader(json, new JsonReaderOptions
        {
            MaxDepth = MaxReadDepth,
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow
        });
        while (reader.Read())
        {
            if (reader.TokenType is not (JsonTokenType.String or JsonTokenType.PropertyName))
            {
                continue;
            }
            ReadOnlySpan<byte> text = reader.ValueSpan;
            for (int index = 0; index < text.Length; index++)
            {
                if (text[index] != (byte)'\\')
                {
                    continue;
                }
                index++;
                if (text[index] != (byte)'u')
                {
                    continue;
                }
                int codeUnit = ReadHex(text.Slice(index + 1, 4));
                index += 4;
                if (codeUnit is >= 0xdc00 and <= 0xdfff)
                {
                    return false;
                }
                if (codeUnit is >= 0xd800 and <= 0xdbff)
                {
                    if (index + 6 >= text.Length || text[index + 1] != (byte)'\\' || text[index + 2] != (byte)'u'
                        || ReadHex(text.Slice(index + 3, 4)) is not (>= 0xdc00 and <= 0xdfff))
                    {
                        return false;
                    }
                    index += 6;
                }
            }
        }
        return true;
    }

    private static int ReadHex(ReadOnlySpan<byte> digits)
    {
        int result = 0;
        foreach (byte digit in digits)
        {
            result = result * 16 + (digit <= (byte)'9' ? digit - '0' : (digit | 0x20) - 'a' + 10);
        }
        return result;
    }

    private static string ComputeDigest(IReadOnlyList<ArticlePackageManifestArticle> articles)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var writer = new DigestWriter(hash);
        writer.Add(DigestDomain);
        writer.Add(1);
        writer.Add(1);
        writer.Add(1);
        writer.Add(articles.Count);
        foreach (ArticlePackageManifestArticle article in articles)
        {
            writer.Add(article.PortableArticle.Value!);
            ArticlePackageManifestSource source = article.Source;
            writer.Add(source.ArticleId);
            writer.Add(source.ArticleRevisionId);
            writer.Add(source.RevisionNo);
            writer.Add(source.CanonicalHash);
            writer.Add(source.SiteScope);
            writer.Add(source.PropertyRevision);
            writer.Add(source.DraftId);
            writer.Add(source.DraftServerRevision);
            writer.Add(source.PublicationId);
            writer.Add(article.Title);
            writer.AddNullable(article.Summary);
            writer.Add(article.TitleSummaryDigest);
            writer.Add(article.PropertySnapshotDigest);
            writer.Add(article.PropertyMappingDigest);
            ArticlePackageByteMetadata bytes = article.SourceBytes;
            writer.Add(bytes.ByteLength);
            writer.Add(bytes.Sha256);
            writer.Add(bytes.HasUtf8Bom ? 1 : 0);
            writer.Add(bytes.LfCount);
            writer.Add(bytes.CrLfCount);
            writer.Add(bytes.BareCrCount);
            writer.Add((int)bytes.FinalNewline);
            writer.Add(bytes.TrailingSpaceCount);
            writer.Add(bytes.TrailingTabCount);
            writer.Add(article.Lifecycle.Status);
            writer.AddNullable(FormatDate(article.Lifecycle.PublishedAt));
            writer.AddNullable(FormatDate(article.Lifecycle.ScheduledPublishAt));
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static string? FormatDate(DateTime? date) => date?.ToString(UtcFormat, CultureInfo.InvariantCulture);

    private static void WriteDocument(Utf8JsonWriter writer, IReadOnlyList<ArticlePackageManifestArticle> articles, string digest)
    {
        writer.WriteStartObject();
        writer.WriteNumber("schemaVersion", 1);
        writer.WriteNumber("canonicalHashVersion", 1);
        writer.WriteNumber("propertySchemaVersion", 1);
        writer.WriteStartArray("articles");
        foreach (ArticlePackageManifestArticle article in articles)
        {
            WriteArticle(writer, article);
            writer.Flush();
        }
        writer.WriteEndArray();
        writer.WriteString("semanticDigest", digest);
        writer.WriteEndObject();
    }

    private static void WriteArticle(Utf8JsonWriter writer, ArticlePackageManifestArticle article)
    {
        writer.WriteStartObject();
        writer.WriteString("portableArticle", article.PortableArticle.Value);
        writer.WriteStartObject("source");
        writer.WriteNumber("articleId", article.Source.ArticleId);
        writer.WriteNumber("articleRevisionId", article.Source.ArticleRevisionId);
        writer.WriteNumber("revisionNo", article.Source.RevisionNo);
        writer.WriteString("canonicalHash", article.Source.CanonicalHash);
        writer.WriteString("siteScope", article.Source.SiteScope);
        writer.WriteNumber("propertyRevision", article.Source.PropertyRevision);
        WriteNullableLong(writer, "draftId", article.Source.DraftId);
        WriteNullableLong(writer, "draftServerRevision", article.Source.DraftServerRevision);
        WriteNullableLong(writer, "publicationId", article.Source.PublicationId);
        writer.WriteEndObject();
        writer.WriteString("title", article.Title);
        writer.WriteString("summary", article.Summary);
        writer.WriteString("titleSummaryDigest", article.TitleSummaryDigest);
        writer.WriteString("propertySnapshotDigest", article.PropertySnapshotDigest);
        writer.WriteString("propertyMappingDigest", article.PropertyMappingDigest);
        writer.WriteStartObject("sourceBytes");
        writer.WriteNumber("byteLength", article.SourceBytes.ByteLength);
        writer.WriteString("sha256", article.SourceBytes.Sha256);
        writer.WriteBoolean("hasUtf8Bom", article.SourceBytes.HasUtf8Bom);
        writer.WriteNumber("lfCount", article.SourceBytes.LfCount);
        writer.WriteNumber("crLfCount", article.SourceBytes.CrLfCount);
        writer.WriteNumber("bareCrCount", article.SourceBytes.BareCrCount);
        writer.WriteNumber("finalNewline", (int)article.SourceBytes.FinalNewline);
        writer.WriteNumber("trailingSpaceCount", article.SourceBytes.TrailingSpaceCount);
        writer.WriteNumber("trailingTabCount", article.SourceBytes.TrailingTabCount);
        writer.WriteEndObject();
        writer.WriteStartObject("lifecycle");
        writer.WriteNumber("status", article.Lifecycle.Status);
        writer.WriteString("publishedAt", FormatDate(article.Lifecycle.PublishedAt));
        writer.WriteString("scheduledPublishAt", FormatDate(article.Lifecycle.ScheduledPublishAt));
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteNullableLong(Utf8JsonWriter writer, string name, long? value)
    {
        if (value.HasValue)
        {
            writer.WriteNumber(name, value.Value);
        }
        else
        {
            writer.WriteNull(name);
        }
    }

    private sealed class DigestWriter(IncrementalHash hash)
    {
        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
            hash.AppendData(bytes);
        }

        public void Add(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
            hash.AppendData(bytes);
        }

        public void Add(long? value)
        {
            Add(value.HasValue ? 1 : 0);
            if (value.HasValue)
            {
                Add(value.Value);
            }
        }

        public void Add(string value)
        {
            byte[] bytes = s_utf8.GetBytes(value);
            Add(bytes.Length);
            hash.AppendData(bytes);
        }

        public void AddNullable(string? value)
        {
            Add(value is null ? 0 : 1);
            if (value is not null)
            {
                Add(value);
            }
        }
    }

    private sealed class DocumentBudgetException : Exception;

    private sealed class BudgetStream : Stream
    {
        private long _count;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _count;
        public override long Position
        {
            get => _count;
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (buffer.Length > MaxJsonBytes - _count)
            {
                throw new DocumentBudgetException();
            }
            _count += buffer.Length;
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
