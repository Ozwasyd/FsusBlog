using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

/// <summary>Canonicalizes set ordering, rejects unknown JSON and seals the sole portable dependency format.</summary>
public static class PortableDependencyCodec
{
    private static readonly JsonSerializerOptions s_options = CreateOptions();

    public static string NodeKey(VaultDependencyNode node)
        => ArticleEmbedContractDigest.Compute(writer =>
        {
            writer.Add(node.Binding.SiteIdentity);
            writer.Add(node.Binding.VaultIdentity);
            writer.Add(node.Binding.PortableArticleIdentity);
            switch (node)
            {
                case VaultAssetDependency asset:
                    writer.Add("asset");
                    writer.Add(asset.AssetIdentity.ToString("D"));
                    break;
                case VaultLinkDependency link:
                    writer.Add("link");
                    AddTarget(writer, link.Target);
                    break;
                case VaultAnchorDependency anchor:
                    writer.Add("anchor");
                    writer.Add(anchor.Target.ArticleIdentity);
                    writer.Add(anchor.Target.AnchorId.Value);
                    break;
                case VaultFrozenEmbedDependency embed:
                    writer.Add("frozen-embed");
                    AddTarget(writer, embed.Coordinate.Target);
                    writer.Add(embed.Coordinate.ResolvedRevision);
                    break;
                default:
                    throw new InvalidDataException("portable_dependency_node_unknown");
            }
        });

    public static string NodeDigest(VaultDependencyNode node)
        => ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(node, s_options));

    /// <summary>Semantic graph identity excludes input list order and any path/label display projection.</summary>
    public static string GraphDigest(PortableDependencyManifest manifest)
        => ArticleEmbedContractDigest.Compute(writer =>
        {
            writer.Add(PortableDependencySchemas.Manifest);
            writer.Add(manifest.Binding.SiteIdentity);
            writer.Add(manifest.Binding.VaultIdentity);
            writer.Add(manifest.Binding.PortableArticleIdentity);
            writer.Add(manifest.Source.Sha256);
            writer.Add(manifest.RelationSha256);
            writer.Add(manifest.Nodes.Count);
            foreach (VaultDependencyNode node in manifest.Nodes.OrderBy(NodeKey, StringComparer.Ordinal))
            {
                writer.Add(NodeKey(node));
                writer.Add(NodeDigest(node));
            }
            writer.Add(manifest.Edges.Count);
            foreach (VaultDependencyEdge edge in OrderedEdges(manifest.Edges))
            {
                writer.Add(edge.PrerequisiteKey);
                writer.Add(edge.DependentKey);
                writer.Add((int)edge.Kind);
            }
        });

    public static string ManifestDigest(PortableDependencyManifest manifest)
        => ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(
            Canonicalize(manifest) with
            {
                ContentSha256 = string.Empty
            }, s_options));

    public static string PlanDigest(ArticleVaultDependencyPlan plan)
        => ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(plan with
        {
            Items = plan.Items.OrderBy(static item => item.OperationIdentity, StringComparer.Ordinal)
                .Select(static item => item with { Manifest = Canonicalize(item.Manifest) }).ToArray(),
            ContentSha256 = string.Empty
        }, s_options));

    /// <summary>Sealing computes hashes only; it does not establish ledger, mapper, anchor or publication authority.</summary>
    public static PortableDependencyManifest Seal(PortableDependencyManifest manifest)
    {
        PortableDependencyManifest canonical = Canonicalize(manifest);
        return canonical with
        {
            ContentSha256 = ManifestDigest(canonical)
        };
    }

    public static byte[] Serialize(PortableDependencyManifest manifest)
    {
        EnsureValid(PortableDependencyVerifier.ValidateStructure(manifest));
        return JsonSerializer.SerializeToUtf8Bytes(Canonicalize(manifest), s_options);
    }

    public static byte[] Serialize(ArticleVaultDependencyPlan plan)
    {
        EnsureValid(ArticleVaultDependencyPlanner.ValidateStructure(plan));
        return JsonSerializer.SerializeToUtf8Bytes(plan, s_options);
    }

    public static ArticleVaultDependencyPlan DeserializePlan(ReadOnlySpan<byte> utf8)
    {
        if (utf8.Length > ArticleEmbedResolutionBudgetLimits.SourceBytesBound)
        {
            throw new InvalidDataException("portable_dependency_serialized_size_exceeded");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8.ToArray());
            RejectDuplicateProperties(document.RootElement);
            ArticleVaultDependencyPlan plan = JsonSerializer.Deserialize<ArticleVaultDependencyPlan>(utf8, s_options)
                ?? throw new InvalidDataException("portable_dependency_extension_missing");
            EnsureValid(ArticleVaultDependencyPlanner.ValidateStructure(plan));
            return plan;
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("portable_dependency_schema_invalid", exception);
        }
    }

    public static PortableDependencyManifest Deserialize(ReadOnlySpan<byte> utf8)
    {
        if (utf8.Length > ArticleEmbedResolutionBudgetLimits.SourceBytesBound)
        {
            throw new InvalidDataException("portable_dependency_serialized_size_exceeded");
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8.ToArray());
            RejectDuplicateProperties(document.RootElement);
            PortableDependencyManifest manifest = JsonSerializer.Deserialize<PortableDependencyManifest>(utf8, s_options)
                ?? throw new InvalidDataException("portable_dependency_manifest_missing");
            EnsureValid(PortableDependencyVerifier.ValidateStructure(manifest));
            return Canonicalize(manifest);
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("portable_dependency_schema_invalid", exception);
        }
    }

    private static PortableDependencyManifest Canonicalize(PortableDependencyManifest manifest)
        => manifest with
        {
            Nodes = manifest.Nodes.OrderBy(NodeKey, StringComparer.Ordinal).ToArray(),
            Edges = OrderedEdges(manifest.Edges).ToArray()
        };

    private static IOrderedEnumerable<VaultDependencyEdge> OrderedEdges(IEnumerable<VaultDependencyEdge> edges)
        => edges.OrderBy(static edge => edge.PrerequisiteKey, StringComparer.Ordinal)
            .ThenBy(static edge => edge.DependentKey, StringComparer.Ordinal)
            .ThenBy(static edge => edge.Kind);

    private static void AddTarget(ArticleEmbedContractDigest.CanonicalWriter writer, ArticleEmbedTargetIdentity target)
    {
        writer.Add(target.PortableArticleIdentity);
        writer.Add((int)target.Kind);
        writer.Add(target.HeadingIdentity);
        writer.Add(target.BlockAnchor);
    }

    private static void EnsureValid(ArticleVaultValidationResult result)
    {
        if (!result.IsValid)
        {
            throw new InvalidDataException(result.ReasonCode);
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            HashSet<string> names = new(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new JsonException("portable_dependency_duplicate_property");
                }
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }

    private static JsonSerializerOptions CreateOptions()
    {
        JsonSerializerOptions options = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            RespectRequiredConstructorParameters = true,
            MaxDepth = 64
        };
        options.Converters.Add(new ClosedEnumConverter<VaultDependencySourceSide>());
        options.Converters.Add(new ClosedEnumConverter<VaultDependencyRight>());
        options.Converters.Add(new ClosedEnumConverter<VaultDependencyEdgeKind>());
        options.Converters.Add(new ClosedEnumConverter<VaultNewlineStyle>());
        options.Converters.Add(new ClosedEnumConverter<ArticleEmbedPermissionStatus>());
        options.Converters.Add(new ClosedEnumConverter<ArticleEmbedTargetKind>());
        options.Converters.Add(new AnchorConverter());
        return options;
    }

    private sealed class ClosedEnumConverter<T> : JsonConverter<T> where T : struct, Enum
    {
        public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            string? text = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
            if (text is null || !Enum.TryParse(text.Replace("-", "", StringComparison.Ordinal), true, out T value)
                || text != CanonicalName(value))
            {
                throw new JsonException("portable_dependency_enum_unknown");
            }
            return value;
        }

        public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
            => writer.WriteStringValue(CanonicalName(value));

        private static string CanonicalName(T value)
        {
            string name = value.ToString();
            if (name.Length == 0 || !char.IsAsciiLetter(name[0]))
            {
                throw new JsonException("portable_dependency_enum_unknown");
            }
            return string.Join(", ", name.Split(", ", StringSplitOptions.None)
                .Select(JsonNamingPolicy.KebabCaseLower.ConvertName));
        }
    }

    private sealed class AnchorConverter : JsonConverter<BlockAnchorId>
    {
        public override BlockAnchorId Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType != JsonTokenType.String
                || !BlockAnchorId.TryCreate(reader.GetString(), out BlockAnchorId id).IsValid)
            {
                throw new JsonException("portable_dependency_anchor_invalid");
            }
            return id;
        }

        public override void Write(Utf8JsonWriter writer, BlockAnchorId value, JsonSerializerOptions options)
            => writer.WriteStringValue(value.Value);
    }
}
