using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Pure closed policy-component methods of the sole manifest candidate codec.</summary>
public static partial class ArticlePackageManifestCandidateCodec
{
    public const int MaxMetadataJsonBytes = 256 * 1024;
    public const int MaxResponsibilityAuthors = 32;
    public const int MaxResponsibilitySources = 64;
    public const string MetadataDigestDomain = "fsusblog.article-package.manifest-metadata-candidate.v1";

    private static readonly JsonSerializerOptions s_metadataJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static ArticlePackageManifestCandidateResult TryCreateMetadataCandidate(
        ArticlePackageManifestMetadataInput? input,
        out ArticlePackageManifestMetadataCandidate? candidate)
    {
        candidate = null;
        if (input?.Article is null || input.CanonicalRights is null || input.Responsibility is null)
        {
            return Invalid("article_package_manifest_metadata_shape_invalid");
        }
        try
        {
            ArticlePackageManifestResponsibility responsibility = input.Responsibility;
            if (!TryCopyMetadataRows(responsibility.Authors, MaxResponsibilityAuthors, out ArticleResponsiblePerson[] authors)
                || !TryCopyMetadataRows(responsibility.Sources, MaxResponsibilitySources, out ArticleEvidenceSource[] sources))
            {
                return Invalid("article_package_manifest_metadata_collection_invalid");
            }
            responsibility = responsibility with
            {
                Authors = Array.AsReadOnly(authors),
                Sources = Array.AsReadOnly(sources)
            };
            input = input with
            {
                Responsibility = responsibility
            };
            if (!TryCreateCandidate([input.Article], out _).IsValid || !ValidMetadataPolicy(input))
            {
                return Invalid("article_package_manifest_metadata_shape_invalid");
            }
            if (sources.Any(static source => !source.IsPublic))
            {
                return Invalid("article_package_manifest_metadata_private_source_rejected");
            }
            if (!ValidMetadataResponsibility(responsibility))
            {
                return Invalid("article_package_manifest_metadata_shape_invalid");
            }
            _ = SerializeMetadata(input, new string('0', 64));
            byte[] payload = SerializeMetadata(input, null);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            // Fixed domain plus NUL separates this closed component from canonical policy/package digests.
            hash.AppendData(s_utf8.GetBytes(MetadataDigestDomain + "\0"));
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
            return Invalid("article_package_manifest_metadata_budget_exceeded");
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_metadata_shape_invalid");
        }
    }

    public static ArticlePackageManifestCandidateResult TryBindMetadataCandidate(
        ArticlePackageManifestMetadataCandidate? candidate,
        ArticlePackageManifestMetadataInput? input,
        out ArticlePackageManifestMetadataCandidate? rebound)
    {
        rebound = null;
        ArticlePackageManifestCandidateResult result = TryCreateMetadataCandidate(input, out var current);
        if (!result.IsValid)
        {
            return result;
        }
        if (candidate is null || !TryCreateMetadataCandidate(candidate.Input, out var checkedCandidate).IsValid
            || candidate.ComponentDigest != checkedCandidate!.ComponentDigest
            || candidate.ComponentDigest != current!.ComponentDigest)
        {
            return Invalid("article_package_manifest_metadata_binding_mismatch");
        }
        rebound = current;
        return new(true, null);
    }

    public static byte[] WriteMetadataCandidate(ArticlePackageManifestMetadataCandidate candidate)
    {
        if (candidate is null || !TryCreateMetadataCandidate(candidate.Input, out var checkedCandidate).IsValid
            || checkedCandidate!.ComponentDigest != candidate.ComponentDigest)
        {
            throw new ArgumentException("article_package_manifest_metadata_candidate_invalid");
        }
        return SerializeMetadata(candidate.Input, candidate.ComponentDigest);
    }

    public static ArticlePackageManifestCandidateResult TryParseMetadataCandidate(
        ReadOnlySpan<byte> json,
        out ArticlePackageManifestMetadataCandidate? candidate)
    {
        candidate = null;
        if (json.Length > MaxMetadataJsonBytes)
        {
            return Invalid("article_package_manifest_metadata_budget_exceeded");
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
            ArticlePackageManifestCandidateResult shape = CheckMetadataKeys(root);
            if (!shape.IsValid)
            {
                return shape;
            }
            ArticlePackageManifestCandidateResult articleResult = ReadArticle(root.GetProperty("article"), out var article);
            if (!articleResult.IsValid)
            {
                return articleResult;
            }
            if (!ReadString(root, "rightsPolicyHash", out string? policyHash)
                || !ReadString(root, "componentDigest", out string? componentDigest)
                || !IsDigest(componentDigest)
                || !ReadDate(root.GetProperty("responsibility"), "effectiveAt", out _))
            {
                return Invalid("article_package_manifest_metadata_shape_invalid");
            }
            var input = new ArticlePackageManifestMetadataInput(
                article!,
                root.GetProperty("rights").Deserialize<ArticleRightsRequestCoreModel>(s_metadataJsonOptions),
                root.GetProperty("canonicalRights").Deserialize<ArticleRightsCanonicalInput>(s_metadataJsonOptions)!,
                policyHash!,
                root.GetProperty("responsibility").Deserialize<ArticlePackageManifestResponsibility>(s_metadataJsonOptions)!);
            ArticlePackageManifestCandidateResult result = TryCreateMetadataCandidate(input, out var parsed);
            if (!result.IsValid)
            {
                return result;
            }
            if (parsed!.ComponentDigest != componentDigest)
            {
                return Invalid("article_package_manifest_metadata_digest_mismatch");
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
            return Invalid("article_package_manifest_metadata_shape_invalid");
        }
    }

    private static bool ValidMetadataPolicy(ArticlePackageManifestMetadataInput input)
    {
        ArticleRightsRequestCoreModel rights = input.Rights;
        ArticleRightsCanonicalInput canonical = input.CanonicalRights;
        ArticlePackageManifestSource source = input.Article.Source;
        if (!MetadataText(rights.LicenseType, 48, true) || !MetadataText(rights.CopyPolicy, 48, true)
            || !MetadataText(rights.CopyrightHolder, 256) || !MetadataText(rights.RightsStatement, 4000)
            || !MetadataText(rights.AttributionTemplate, 4000) || rights.MaxExcerptChars < 0
            || canonical.ArticleId != source.ArticleId || canonical.ArticleRevisionId != source.ArticleRevisionId
            || canonical.RevisionNo != source.RevisionNo || canonical.ContentCanonicalHash != "sha256:" + source.CanonicalHash
            || canonical.LicenseType != rights.LicenseType || canonical.CopyrightHolder != rights.CopyrightHolder
            || canonical.CopyrightYear != rights.CopyrightYear || canonical.RightsStatement != rights.RightsStatement
            || canonical.AttributionTemplate != rights.AttributionTemplate || canonical.CopyPolicy != rights.CopyPolicy
            || canonical.MaxExcerptChars != rights.MaxExcerptChars || canonical.AllowCodeCopy != rights.AllowCodeCopy
            || canonical.ShowPublicBadge != rights.ShowPublicBadge || !MetadataPublicUrl(canonical.CanonicalUrl, false))
        {
            return false;
        }
        // The canonical owner alone computes the rights digest; Enabled/ProofBindingEnabled are separately component-bound.
        return input.RightsPolicyHash == ArticleRightsCanonicalHashV1.ComputeHashHex(canonical);
    }

    private static bool ValidMetadataResponsibility(ArticlePackageManifestResponsibility value)
    {
        if (value.ResponsibilityVersion <= 0 || value.EffectiveAt is { Kind: not DateTimeKind.Utc }
            || !MetadataText(value.UpdateSummary, 512) || !MetadataText(value.UpdateReason, 512)
            || !MetadataText(value.ConclusionImpact, 32) || !MetadataText(value.Methodology, 16 * 1024)
            || !MetadataText(value.Applicability, 16 * 1024) || !MetadataText(value.Limitations, 16 * 1024))
        {
            return false;
        }
        foreach (ArticleResponsiblePerson author in value.Authors)
        {
            if (!ValidMetadataPerson(author))
            {
                return false;
            }
        }
        if (value.Reviewer is not null && !ValidMetadataPerson(value.Reviewer))
        {
            return false;
        }
        foreach (ArticleEvidenceSource source in value.Sources)
        {
            if (!MetadataText(source.Title, 512, true) || !MetadataPublicUrl(source.Url, true)
                || !MetadataText(source.SourceType, 64, true) || !MetadataText(source.Version, 256)
                || !MetadataText(source.CitationNote, 4000))
            {
                return false;
            }
        }
        // Historical flags are preserved, not reinterpreted as a prepublication/confirmation decision.
        return true;
    }

    private static bool ValidMetadataPerson(ArticleResponsiblePerson value)
        => MetadataText(value.Name, 256, true) && MetadataPublicUrl(value.ProfileUrl, false);

    private static bool MetadataPublicUrl(string? value, bool required)
        => value is null ? !required : MetadataText(value, 2048, true) && ArticleResponsibilityGovernance.PublicUrl(value) is not null;

    private static bool MetadataText(string? value, int maximum, bool required = false)
    {
        if (value is null)
        {
            return !required;
        }
        if (value.Length > maximum || required && string.IsNullOrWhiteSpace(value))
        {
            return false;
        }
        _ = s_utf8.GetByteCount(value);
        return true;
    }

    private static bool TryCopyMetadataRows<T>(IReadOnlyList<T>? rows, int maximum, out T[] held) where T : class
    {
        held = [];
        try
        {
            if (rows is null)
            {
                return false;
            }
            int count = rows.Count;
            if (count < 0 || count > maximum)
            {
                return false;
            }
            var copy = new T[count];
            for (int index = 0; index < count; index++)
            {
                T row = rows[index];
                if (row is null)
                {
                    return false;
                }
                copy[index] = row;
            }
            held = copy;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static ArticlePackageManifestCandidateResult CheckMetadataObjectKeys(JsonElement value, params string[] names)
        => CheckClosedKeys(value, names, false);

    private static ArticlePackageManifestCandidateResult CheckMetadataKeys(JsonElement root)
    {
        ArticlePackageManifestCandidateResult result = CheckMetadataObjectKeys(root,
            "article", "rights", "canonicalRights", "rightsPolicyHash", "responsibility", "componentDigest");
        if (!result.IsValid)
        {
            return result;
        }
        result = CheckMetadataObjectKeys(root.GetProperty("rights"), "enabled", "licenseType", "copyrightHolder", "copyrightYear",
            "rightsStatement", "attributionTemplate", "copyPolicy", "maxExcerptChars", "allowCodeCopy", "showPublicBadge", "proofBindingEnabled");
        if (!result.IsValid)
        {
            return result;
        }
        result = CheckMetadataObjectKeys(root.GetProperty("canonicalRights"), "articleId", "articleRevisionId", "revisionNo", "licenseType",
            "copyrightHolder", "copyrightYear", "rightsStatement", "attributionTemplate", "copyPolicy", "maxExcerptChars",
            "allowCodeCopy", "showPublicBadge", "canonicalUrl", "contentCanonicalHash");
        if (!result.IsValid)
        {
            return result;
        }
        JsonElement responsibility = root.GetProperty("responsibility");
        result = CheckMetadataObjectKeys(responsibility, "responsibilityVersion", "inheritSiteAuthor", "authors", "reviewer", "sources",
            "updateSummary", "updateReason", "effectiveAt", "conclusionImpact", "methodology", "applicability", "limitations", "responsiblePersonConfirmed");
        if (!result.IsValid)
        {
            return result;
        }
        JsonElement authors = responsibility.GetProperty("authors");
        JsonElement sources = responsibility.GetProperty("sources");
        if (authors.ValueKind != JsonValueKind.Array || authors.GetArrayLength() > MaxResponsibilityAuthors
            || sources.ValueKind != JsonValueKind.Array || sources.GetArrayLength() > MaxResponsibilitySources)
        {
            return Invalid("article_package_manifest_metadata_collection_invalid");
        }
        foreach (JsonElement author in authors.EnumerateArray())
        {
            result = CheckMetadataObjectKeys(author, "name", "profileUrl");
            if (!result.IsValid)
            {
                return result;
            }
        }
        JsonElement reviewer = responsibility.GetProperty("reviewer");
        if (reviewer.ValueKind != JsonValueKind.Null)
        {
            result = CheckMetadataObjectKeys(reviewer, "name", "profileUrl");
            if (!result.IsValid)
            {
                return result;
            }
        }
        foreach (JsonElement source in sources.EnumerateArray())
        {
            result = CheckMetadataObjectKeys(source, "title", "url", "sourceType", "accessedOn", "version", "citationNote", "isPublic");
            if (!result.IsValid)
            {
                return result;
            }
        }
        return new(true, null);
    }

    private static byte[] SerializeMetadata(ArticlePackageManifestMetadataInput input, string? digest)
    {
        using var stream = new MetadataBudgetStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WritePropertyName("article");
            WriteArticle(writer, input.Article);
            writer.WritePropertyName("rights");
            JsonSerializer.Serialize(writer, input.Rights, s_metadataJsonOptions);
            writer.WritePropertyName("canonicalRights");
            JsonSerializer.Serialize(writer, input.CanonicalRights, s_metadataJsonOptions);
            writer.WriteString("rightsPolicyHash", input.RightsPolicyHash);
            writer.WritePropertyName("responsibility");
            WriteMetadataResponsibility(writer, input.Responsibility);
            if (digest is not null)
            {
                writer.WriteString("componentDigest", digest);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static void WriteMetadataResponsibility(Utf8JsonWriter writer, ArticlePackageManifestResponsibility value)
    {
        // Explicit UTC spelling must match the sole manifest date parser, not ambient serializer formatting.
        writer.WriteStartObject();
        writer.WriteNumber("responsibilityVersion", value.ResponsibilityVersion);
        writer.WriteBoolean("inheritSiteAuthor", value.InheritSiteAuthor);
        writer.WritePropertyName("authors");
        JsonSerializer.Serialize(writer, value.Authors, s_metadataJsonOptions);
        writer.WritePropertyName("reviewer");
        JsonSerializer.Serialize(writer, value.Reviewer, s_metadataJsonOptions);
        writer.WritePropertyName("sources");
        JsonSerializer.Serialize(writer, value.Sources, s_metadataJsonOptions);
        writer.WriteString("updateSummary", value.UpdateSummary);
        writer.WriteString("updateReason", value.UpdateReason);
        writer.WriteString("effectiveAt", FormatDate(value.EffectiveAt));
        writer.WriteString("conclusionImpact", value.ConclusionImpact);
        writer.WriteString("methodology", value.Methodology);
        writer.WriteString("applicability", value.Applicability);
        writer.WriteString("limitations", value.Limitations);
        writer.WriteBoolean("responsiblePersonConfirmed", value.ResponsiblePersonConfirmed);
        writer.WriteEndObject();
    }

    private sealed class MetadataBudgetStream : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count)
        {
            if (count > MaxMetadataJsonBytes - Length)
            {
                throw new DocumentBudgetException();
            }
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (buffer.Length > MaxMetadataJsonBytes - Length)
            {
                throw new DocumentBudgetException();
            }
            // MemoryStream's span override dispatches back to Write(byte[],...) for derived types.
            // Calling the base array overload directly prevents virtual-recursion on this boundary.
            byte[] owned = buffer.ToArray();
            base.Write(owned, 0, owned.Length);
        }
    }
}
