using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Serializes, deserializes, and content-addresses canonical Article Vault contracts.</summary>
public static class ArticleVaultManifestCodec
{
    private static readonly JsonSerializerOptions s_jsonOptions = CreateJsonOptions();

    public static byte[] Serialize(ArticleVaultRootManifest manifest)
    {
        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return JsonSerializer.SerializeToUtf8Bytes(manifest, s_jsonOptions);
    }

    public static byte[] Serialize(ArticleVaultArticleManifest manifest)
    {
        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return JsonSerializer.SerializeToUtf8Bytes(manifest, s_jsonOptions);
    }

    public static byte[] Serialize(ArticleVaultMetadataManifest manifest)
    {
        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return JsonSerializer.SerializeToUtf8Bytes(manifest, s_jsonOptions);
    }

    public static ArticleVaultRootManifest DeserializeRoot(ReadOnlySpan<byte> utf8)
    {
        ArticleVaultRootManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<ArticleVaultRootManifest>(utf8, s_jsonOptions)
                ?? throw new InvalidDataException("article_vault_root_manifest_missing");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("article_vault_root_schema_invalid", exception);
        }

        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return manifest;
    }

    public static ArticleVaultArticleManifest DeserializeArticle(ReadOnlySpan<byte> utf8)
    {
        ArticleVaultArticleManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<ArticleVaultArticleManifest>(utf8, s_jsonOptions)
                ?? throw new InvalidDataException("article_vault_article_manifest_missing");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("article_vault_article_schema_invalid", exception);
        }

        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return manifest;
    }

    public static ArticleVaultMetadataManifest DeserializeMetadata(ReadOnlySpan<byte> utf8)
    {
        ArticleVaultMetadataManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<ArticleVaultMetadataManifest>(utf8, s_jsonOptions)
                ?? throw new InvalidDataException("article_vault_metadata_manifest_missing");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("article_vault_metadata_schema_invalid", exception);
        }

        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(manifest);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return manifest;
    }

    public static string ComputeContentSha256(ArticleVaultRootManifest manifest)
    {
        ArticleVaultRootManifest unsealed = manifest with
        {
            ContentSha256 = string.Empty
        };
        return ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed, s_jsonOptions));
    }

    public static string ComputeContentSha256(ArticleVaultArticleManifest manifest)
    {
        ArticleVaultArticleManifest unsealed = manifest with
        {
            ContentSha256 = string.Empty
        };
        return ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed, s_jsonOptions));
    }

    public static string ComputeContentSha256(ArticleVaultMetadataManifest manifest)
    {
        ArticleVaultMetadataManifest unsealed = manifest with
        {
            ContentSha256 = string.Empty
        };
        return ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed, s_jsonOptions));
    }

    public static string ComputeContentSha256(VaultArticleCoordinate coordinate)
    {
        VaultArticleCoordinate unsealed = coordinate with
        {
            ContentSha256 = string.Empty
        };
        return ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed, s_jsonOptions));
    }

    public static string ComputeProjectionSha256(string relativePath)
        => ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(
            new
            {
                relativePath
            },
            s_jsonOptions));

    public static string ComputeSha256(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));

    internal static byte[] SerializeCanonical<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions);

    internal static T? DeserializeCanonical<T>(ReadOnlySpan<byte> utf8)
        => JsonSerializer.Deserialize<T>(utf8, s_jsonOptions);

    public static VaultSourceByteIdentity CaptureSourceBytes(ReadOnlySpan<byte> bytes)
    {
        bool hasUtf8Bom = bytes.Length >= 3
            && bytes[0] == 0xef
            && bytes[1] == 0xbb
            && bytes[2] == 0xbf;
        ReadOnlySpan<byte> content = hasUtf8Bom ? bytes[3..] : bytes;
        _ = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
            .GetCharCount(content);

        bool hasLf = false;
        bool hasCrLf = false;
        bool hasLoneCr = false;
        int trailingWhitespaceLineCount = 0;
        int lineStart = 0;
        for (int index = 0; index < content.Length; index++)
        {
            if (content[index] == (byte)'\r')
            {
                CountTrailingWhitespace(content[lineStart..index], ref trailingWhitespaceLineCount);
                if (index + 1 < content.Length && content[index + 1] == (byte)'\n')
                {
                    hasCrLf = true;
                    index++;
                }
                else
                {
                    hasLoneCr = true;
                }

                lineStart = index + 1;
            }
            else if (content[index] == (byte)'\n')
            {
                CountTrailingWhitespace(content[lineStart..index], ref trailingWhitespaceLineCount);
                hasLf = true;
                lineStart = index + 1;
            }
        }

        if (lineStart < content.Length)
        {
            CountTrailingWhitespace(content[lineStart..], ref trailingWhitespaceLineCount);
        }

        VaultNewlineStyle newlineStyle = (hasLf, hasCrLf, hasLoneCr) switch
        {
            (false, false, false) => VaultNewlineStyle.None,
            (true, false, false) => VaultNewlineStyle.Lf,
            (false, true, false) => VaultNewlineStyle.CrLf,
            _ => VaultNewlineStyle.Mixed
        };
        bool hasFinalNewline = content.Length > 0 && content[^1] is (byte)'\n' or (byte)'\r';
        return new VaultSourceByteIdentity(
            ComputeSha256(bytes),
            bytes.Length,
            hasUtf8Bom,
            newlineStyle,
            trailingWhitespaceLineCount,
            hasFinalNewline);
    }

    private static void CountTrailingWhitespace(ReadOnlySpan<byte> line, ref int count)
    {
        if (line.Length > 0 && line[^1] is (byte)' ' or (byte)'\t')
        {
            count++;
        }
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            WriteIndented = false
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower, allowIntegerValues: false));
        return options;
    }
}

/// <summary>Validates closed Article Vault schemas, bindings, coordinates, and byte facts.</summary>
public static class ArticleVaultManifestValidator
{
    private static readonly char[] s_forbiddenIdentityCharacters = ['\0', '\r', '\n', '/', '\\'];
    private static readonly HashSet<string> s_lifecycleValues = new(
        Enumerable.Range(ArticleStatusValues.Draft, ArticleStatusValues.Inbox + 1)
            .Select(ArticleStatusValues.Token), StringComparer.Ordinal);

    public static ArticleVaultValidationResult Validate(ArticleVaultRootManifest? manifest)
    {
        if (manifest is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_root_manifest_missing");
        }

        if (manifest.Schema != ArticleVaultSchemas.RootManifest
            || manifest.SchemaVersion != ArticleVaultSchemas.Version
            || manifest.ControlTreeVersion != ArticleVaultSchemas.ControlTreeVersion)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_root_schema_unknown");
        }

        if (manifest.ControlTree is null
            || manifest.ControlTree.RootManifestPath != ArticleVaultSchemas.RootManifestPath
            || manifest.ControlTree.ArticleManifestDirectory != ArticleVaultSchemas.ArticleManifestDirectory
            || manifest.ControlTree.ReceiptDirectory != ArticleVaultSchemas.ReceiptDirectory)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_control_tree_invalid");
        }

        ArticleVaultValidationResult identity = ValidateBinding(manifest.SiteIdentity, manifest.VaultIdentity);
        if (!identity.IsValid)
        {
            return identity;
        }

        if (!IsIdentity(manifest.DeviceIdentity))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_device_identity_invalid");
        }

        if (manifest.Articles is null || manifest.OperationReceipts is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_root_inventory_missing");
        }

        string? previousArticle = null;
        foreach (VaultArticleReference article in manifest.Articles)
        {
            if (!IsIdentity(article.PortableArticleIdentity)
                || !IsSha256(article.ManifestSha256)
                || !IsSafeProjection(article.RelativePath)
                || article.ManifestPath != $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json")
            {
                return ArticleVaultValidationResult.Invalid("article_vault_article_reference_invalid");
            }

            if (previousArticle is not null
                && string.CompareOrdinal(previousArticle, article.PortableArticleIdentity) >= 0)
            {
                return ArticleVaultValidationResult.Invalid("article_vault_article_inventory_not_canonical");
            }

            previousArticle = article.PortableArticleIdentity;
        }

        long previousSequence = -1;
        var operationIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (VaultOperationReceiptReference receipt in manifest.OperationReceipts)
        {
            if (!IsIdentity(receipt.OperationIdentity)
                || receipt.Sequence <= previousSequence
                || !IsSha256(receipt.ReceiptSha256)
                || receipt.ReceiptPath != $"{ArticleVaultSchemas.ReceiptDirectory}/{receipt.OperationIdentity}.json"
                || !operationIds.Add(receipt.OperationIdentity))
            {
                return ArticleVaultValidationResult.Invalid("article_vault_receipt_inventory_not_canonical");
            }

            previousSequence = receipt.Sequence;
        }

        if (!IsSha256(manifest.ContentSha256)
            || !CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(manifest.ContentSha256),
                Convert.FromHexString(ArticleVaultManifestCodec.ComputeContentSha256(manifest))))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_root_digest_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult Validate(ArticleVaultArticleManifest? manifest)
    {
        if (manifest is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_article_manifest_missing");
        }

        if (manifest.Schema != ArticleVaultSchemas.ArticleManifest
            || manifest.SchemaVersion != ArticleVaultSchemas.Version)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_article_schema_unknown");
        }

        ArticleVaultValidationResult binding = ValidateBinding(manifest.SiteIdentity, manifest.VaultIdentity);
        if (!binding.IsValid)
        {
            return binding;
        }

        if (!IsIdentity(manifest.DeviceIdentity))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_device_identity_invalid");
        }

        if (!IsIdentity(manifest.PortableArticleIdentity)
            || (manifest.ServerArticleIdentity is not null && !IsIdentity(manifest.ServerArticleIdentity)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_article_identity_invalid");
        }

        if (manifest.PathProjection is null
            || !IsSafeProjection(manifest.PathProjection.RelativePath)
            || !IsSha256(manifest.PathProjection.ProjectionSha256)
            || !FixedDigestEquals(
                manifest.PathProjection.ProjectionSha256,
                ArticleVaultManifestCodec.ComputeProjectionSha256(manifest.PathProjection.RelativePath)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_path_projection_invalid");
        }

        ArticleVaultValidationResult coordinates = ValidateCoordinates(manifest);
        if (!coordinates.IsValid)
        {
            return coordinates;
        }

        ArticleVaultValidationResult watermarks = ValidateWatermarks(manifest.OperationWatermarks);
        if (!watermarks.IsValid)
        {
            return watermarks;
        }

        VaultArticleState derivedState = ArticleVaultStateMachine.Derive(manifest);
        if (manifest.State != derivedState)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_state_mismatch");
        }

        if (!IsSha256(manifest.ContentSha256)
            || !FixedDigestEquals(manifest.ContentSha256, ArticleVaultManifestCodec.ComputeContentSha256(manifest)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_article_digest_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult Validate(ArticleVaultMetadataManifest? manifest)
    {
        if (manifest is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_manifest_missing");
        }

        if (manifest.Schema != ArticleVaultSchemas.MetadataManifest
            || manifest.SchemaVersion != ArticleVaultSchemas.Version)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_schema_unknown");
        }

        ArticleVaultValidationResult binding = ValidateBinding(manifest.SiteIdentity, manifest.VaultIdentity);
        if (!binding.IsValid)
        {
            return binding;
        }

        if (!IsIdentity(manifest.DeviceIdentity)
            || !IsIdentity(manifest.PortableArticleIdentity)
            || (manifest.ServerArticleIdentity is not null && !IsIdentity(manifest.ServerArticleIdentity)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_identity_invalid");
        }

        if (string.IsNullOrWhiteSpace(manifest.Title)
            || string.IsNullOrWhiteSpace(manifest.Slug)
            || !IsSha256(manifest.TaxonomySha256)
            || !IsSha256(manifest.PropertiesSha256))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_mapping_invalid");
        }

        if (!IsSha256(manifest.ContentSha256)
            || !FixedDigestEquals(manifest.ContentSha256, ArticleVaultManifestCodec.ComputeContentSha256(manifest)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_digest_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult ValidateBinding(
        ArticleVaultRootManifest? root,
        ArticleVaultArticleManifest? article)
    {
        ArticleVaultValidationResult rootValidation = Validate(root);
        if (!rootValidation.IsValid)
        {
            return rootValidation;
        }

        ArticleVaultValidationResult articleValidation = Validate(article);
        if (!articleValidation.IsValid)
        {
            return articleValidation;
        }

        if (root!.SiteIdentity != article!.SiteIdentity
            || root.VaultIdentity != article.VaultIdentity
            || root.DeviceIdentity != article.DeviceIdentity)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_cross_binding_mismatch");
        }

        VaultArticleReference? reference = root.Articles.SingleOrDefault(
            candidate => candidate.PortableArticleIdentity == article.PortableArticleIdentity);
        if (reference is null
            || reference.ManifestSha256 != article.ContentSha256
            || reference.RelativePath != article.PathProjection.RelativePath)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_article_reference_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult ValidateBinding(
        ArticleVaultArticleManifest? article,
        ArticleVaultMetadataManifest? metadata)
    {
        ArticleVaultValidationResult articleValidation = Validate(article);
        if (!articleValidation.IsValid)
        {
            return articleValidation;
        }

        ArticleVaultValidationResult metadataValidation = Validate(metadata);
        if (!metadataValidation.IsValid)
        {
            return metadataValidation;
        }

        if (article!.SiteIdentity != metadata!.SiteIdentity
            || article.VaultIdentity != metadata.VaultIdentity
            || article.DeviceIdentity != metadata.DeviceIdentity
            || article.PortableArticleIdentity != metadata.PortableArticleIdentity
            || article.ServerArticleIdentity != metadata.ServerArticleIdentity)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_binding_mismatch");
        }

        if (article.Coordinates.Local.MetadataManifestSha256 != metadata.ContentSha256)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_metadata_reference_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateCoordinates(ArticleVaultArticleManifest manifest)
    {
        if (manifest.Coordinates is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_coordinates_missing");
        }

        ArticleVaultValidationResult baseResult = ValidateCoordinate(manifest.Coordinates.Base, "base", requiresRevision: true);
        if (!baseResult.IsValid)
        {
            return baseResult;
        }

        ArticleVaultValidationResult localResult = ValidateCoordinate(manifest.Coordinates.Local, "local", requiresRevision: false);
        if (!localResult.IsValid)
        {
            return localResult;
        }

        ArticleVaultValidationResult serverResult = ValidateCoordinate(manifest.Coordinates.Server, "server", requiresRevision: true);
        if (!serverResult.IsValid)
        {
            return serverResult;
        }

        bool established = manifest.Coordinates.Base.Present;
        if (established && manifest.ServerArticleIdentity is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_identity_missing");
        }

        if (!established
            && manifest.Coordinates.Local.Present
            && manifest.Coordinates.Server.Present)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_base_coordinate_missing");
        }

        if (manifest.Coordinates.Server.Present && manifest.ServerArticleIdentity is null)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_server_identity_missing");
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateCoordinate(
        VaultArticleCoordinate? coordinate,
        string coordinateName,
        bool requiresRevision)
    {
        if (coordinate is null)
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_coordinate_missing");
        }


        if (coordinate.Schema != ArticleVaultSchemas.Coordinate
            || coordinate.SchemaVersion != ArticleVaultSchemas.Version)
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_coordinate_schema_unknown");
        }

        if (!IsSha256(coordinate.ContentSha256)
            || !FixedDigestEquals(
                coordinate.ContentSha256,
                ArticleVaultManifestCodec.ComputeContentSha256(coordinate)))
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_coordinate_digest_mismatch");
        }

        if (!coordinate.Present)
        {
            if (coordinate.Deleted
                || coordinate.ServerRevision is not null
                || coordinate.Source is not null
                || coordinate.MetadataManifestSha256 is not null
                || coordinate.DependencySha256 is not null
                || coordinate.Lifecycle is not null
                || coordinate.PermissionSha256 is not null)
            {
                return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_coordinate_absent_payload");
            }

            return ArticleVaultValidationResult.Valid();
        }

        if (requiresRevision && coordinate.ServerRevision is null or <= 0)
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_revision_missing");
        }

        if (coordinate.ServerRevision is <= 0)
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_revision_invalid");
        }

        if (coordinate.Deleted)
        {
            if (coordinate.Source is not null || coordinate.MetadataManifestSha256 is not null)
            {
                return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_deleted_payload_invalid");
            }
        }
        else
        {
            ArticleVaultValidationResult source = ValidateSource(coordinate.Source, coordinateName);
            if (!source.IsValid)
            {
                return source;
            }

            if (!IsSha256(coordinate.MetadataManifestSha256))
            {
                return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_metadata_invalid");
            }
        }

        if (!IsSha256(coordinate.DependencySha256)
            || !IsSha256(coordinate.PermissionSha256)
            || coordinate.Lifecycle is null
            || !s_lifecycleValues.Contains(coordinate.Lifecycle))
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_binding_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult ValidateSourceBytes(
        VaultSourceByteIdentity? source,
        ReadOnlySpan<byte> bytes)
    {
        ArticleVaultValidationResult sourceValidation = ValidateSource(source, "source_bytes");
        if (!sourceValidation.IsValid)
        {
            return sourceValidation;
        }

        VaultSourceByteIdentity observed;
        try
        {
            observed = ArticleVaultManifestCodec.CaptureSourceBytes(bytes);
        }
        catch (DecoderFallbackException)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_source_bytes_utf8_invalid");
        }

        return source == observed
            ? ArticleVaultValidationResult.Valid()
            : ArticleVaultValidationResult.Invalid("article_vault_source_bytes_mismatch");
    }

    private static ArticleVaultValidationResult ValidateSource(VaultSourceByteIdentity? source, string coordinateName)
    {
        if (source is null
            || !IsSha256(source.Sha256)
            || source.ByteLength < 0
            || source.TrailingWhitespaceLineCount < 0)
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_source_invalid");
        }

        if (source.NewlineStyle == VaultNewlineStyle.None
            && (source.HasFinalNewline || source.TrailingWhitespaceLineCount > 0))
        {
            return ArticleVaultValidationResult.Invalid($"article_vault_{coordinateName}_source_newline_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateWatermarks(VaultOperationWatermarks? watermarks)
    {
        if (watermarks is null || watermarks.Sequence < 0)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_operation_watermarks_invalid");
        }

        string?[] operationIds =
        [
            watermarks.LastPlannedOperationIdentity,
            watermarks.LastAppliedOperationIdentity,
            watermarks.ApplyingOperationIdentity,
            watermarks.ConflictOperationIdentity
        ];
        if (operationIds.Any(static value => value is not null && !IsIdentity(value)))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_operation_identity_invalid");
        }

        if (watermarks.LastReceiptSha256 is not null && !IsSha256(watermarks.LastReceiptSha256))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_operation_receipt_digest_invalid");
        }

        if ((watermarks.LastAppliedOperationIdentity is null) != (watermarks.LastReceiptSha256 is null))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_operation_receipt_binding_invalid");
        }

        if (watermarks.BlockedReasonCode is not null && !IsReasonCode(watermarks.BlockedReasonCode))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_blocked_reason_invalid");
        }

        int activeMarkers = (watermarks.ApplyingOperationIdentity is null ? 0 : 1)
            + (watermarks.ConflictOperationIdentity is null ? 0 : 1)
            + (watermarks.BlockedReasonCode is null ? 0 : 1);
        if (activeMarkers > 1)
        {
            return ArticleVaultValidationResult.Invalid("article_vault_operation_state_ambiguous");
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateBinding(string siteIdentity, string vaultIdentity)
    {
        if (!IsIdentity(siteIdentity))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_site_identity_invalid");
        }

        if (!IsIdentity(vaultIdentity))
        {
            return ArticleVaultValidationResult.Invalid("article_vault_vault_identity_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    internal static bool CoordinatesEqual(VaultArticleCoordinate left, VaultArticleCoordinate right)
        => left == right;

    internal static bool IsSha256(string? value)
        => value is { Length: 64 } && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool IsIdentity(string? value)
        => value is { Length: >= 3 and <= 128 }
            && value.IndexOfAny(s_forbiddenIdentityCharacters) < 0
            && !value.Any(char.IsWhiteSpace);

    internal static bool IsReasonCode(string value)
        => value.Length is >= 3 and <= 128
            && value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-');

    internal static bool IsSafeProjection(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 1024
            || value[0] == '/'
            || value.Contains('\\', StringComparison.Ordinal)
            || value.Contains('\0', StringComparison.Ordinal))
        {
            return false;
        }

        string[] segments = value.Split('/', StringSplitOptions.None);
        return segments.All(static segment => segment.Length > 0 && segment is not "." and not "..")
            && !string.Equals(segments[0], ".fsus", StringComparison.OrdinalIgnoreCase);
    }

    private static bool FixedDigestEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));
}

/// <summary>Derives Article Vault state only from sealed coordinates and operation watermarks.</summary>
public static class ArticleVaultStateMachine
{
    public static VaultArticleState Derive(ArticleVaultArticleManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        VaultOperationWatermarks watermarks = manifest.OperationWatermarks;
        if (watermarks.BlockedReasonCode is not null)
        {
            return VaultArticleState.Blocked;
        }

        if (watermarks.ApplyingOperationIdentity is not null)
        {
            return VaultArticleState.Applying;
        }

        if (watermarks.ConflictOperationIdentity is not null)
        {
            return VaultArticleState.Conflicted;
        }

        VaultArticleCoordinate baseline = manifest.Coordinates.Base;
        VaultArticleCoordinate local = manifest.Coordinates.Local;
        VaultArticleCoordinate server = manifest.Coordinates.Server;
        if (!baseline.Present)
        {
            return (local.Present, server.Present) switch
            {
                (false, false) => VaultArticleState.Untracked,
                (true, false) => VaultArticleState.LocalCreated,
                (false, true) => VaultArticleState.ServerCreated,
                _ => VaultArticleState.Conflicted
            };
        }

        bool localChanged = !ArticleVaultManifestValidator.CoordinatesEqual(baseline, local);
        bool serverChanged = !ArticleVaultManifestValidator.CoordinatesEqual(baseline, server);
        if (!localChanged && !serverChanged)
        {
            return watermarks.LastAppliedOperationIdentity is null
                ? VaultArticleState.Clean
                : VaultArticleState.Synced;
        }

        if (local.Deleted && !serverChanged)
        {
            return VaultArticleState.LocalDeleted;
        }

        if (server.Deleted && !localChanged)
        {
            return VaultArticleState.ServerDeleted;
        }

        if (localChanged && serverChanged)
        {
            return VaultArticleState.BothModified;
        }

        return localChanged ? VaultArticleState.LocalModified : VaultArticleState.ServerModified;
    }
}
