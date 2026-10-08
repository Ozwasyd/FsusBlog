using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static class CanonicalArticleGraphVerifier
{
    private static readonly JsonSerializerOptions s_jsonWeb = new(JsonSerializerDefaults.Web);

    public static CanonicalArticleGraphVerificationResult VerifyReceipt(
        ArticleScalePlan plan,
        ArticleScaleGraphReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(receipt);

        var violations = new List<string>();

        if (!string.Equals(receipt.Schema, ArticleScaleContractIds.GraphSchema, StringComparison.Ordinal))
        {
            violations.Add($"receipt_schema_mismatch: expected '{ArticleScaleContractIds.GraphSchema}', got '{receipt.Schema}'");
        }
        if (!string.Equals(receipt.PlanSchema, plan.Schema, StringComparison.Ordinal))
        {
            violations.Add($"receipt_plan_schema_mismatch: expected '{plan.Schema}', got '{receipt.PlanSchema}'");
        }
        string expectedPlanDigest = ArticleScalePlanDigest.Compute(plan);
        if (!string.Equals(receipt.PlanDigest, expectedPlanDigest, StringComparison.Ordinal))
        {
            violations.Add($"receipt_plan_digest_tamper: expected '{expectedPlanDigest}', got '{receipt.PlanDigest}'");
        }
        if (!string.Equals(receipt.FactoryId, ArticleScaleContractIds.RequiredGraphFactory, StringComparison.Ordinal))
        {
            violations.Add($"receipt_factory_id_mismatch: expected '{ArticleScaleContractIds.RequiredGraphFactory}', got '{receipt.FactoryId}'");
        }
        if (!string.Equals(receipt.ContentDigest, plan.ContentDigest, StringComparison.Ordinal))
        {
            violations.Add($"receipt_content_digest_mismatch: expected '{plan.ContentDigest}', got '{receipt.ContentDigest}'");
        }

        // Check variant counts
        foreach (ArticleScaleVariantAllocation alloc in plan.StateDistribution)
        {
            string key = alloc.Variant.ToString();
            if (!receipt.VariantCounts.TryGetValue(key, out int actualCount) || actualCount != alloc.Count)
            {
                violations.Add($"receipt_variant_count_mismatch:{key}: expected {alloc.Count}, got {actualCount}");
            }
        }

        // Check expected row counts
        foreach (ArticleScaleExpectedRowCount expectedRow in plan.Postconditions.ExpectedRows)
        {
            string key = expectedRow.Kind.ToString();
            if (!receipt.RowCounts.TryGetValue(key, out long actualCount) || actualCount != expectedRow.Count)
            {
                violations.Add($"receipt_row_count_mismatch:{key}: expected {expectedRow.Count}, got {actualCount}");
            }
        }

        // Check edge count
        long expectedEdges = plan.StateDistribution.Sum(alloc =>
            (long)alloc.Count * alloc.Contract.Transitions.Count * plan.Outbox.RequiredEdges.Count);
        if (receipt.EdgeCount != expectedEdges)
        {
            violations.Add($"receipt_edge_count_mismatch: expected {expectedEdges}, got {receipt.EdgeCount}");
        }

        if (string.IsNullOrWhiteSpace(receipt.SemanticGraphDigest) || !receipt.SemanticGraphDigest.StartsWith("sha256:", StringComparison.Ordinal))
        {
            violations.Add("receipt_semantic_graph_digest_invalid");
        }

        return new CanonicalArticleGraphVerificationResult(violations.Count == 0, violations);
    }

    public static CanonicalArticleGraphVerificationResult VerifyArticleGraph(
        ArticleScalePlan plan,
        ArticleScaleArticleGraph graph)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(graph);

        var violations = new List<string>();

        string prefix = plan.IdAllocation.NamespacePrefix;
        if (!graph.SemanticArticleId.StartsWith(prefix, StringComparison.Ordinal))
        {
            violations.Add($"semantic_article_id_prefix_mismatch: expected prefix '{prefix}', got '{graph.SemanticArticleId}'");
        }

        ArticleScaleVariantContract contract = ArticleScaleVariantContractCatalog.Get(graph.Variant);

        // Check row counts by kind
        var rowGroups = graph.Rows.GroupBy(r => r.Kind).ToDictionary(g => g.Key, g => g.Count());
        foreach (ArticleScaleRowRequirement req in contract.Rows)
        {
            rowGroups.TryGetValue(req.Kind, out int count);
            if (count != req.CountPerArticle)
            {
                violations.Add($"article_row_count_mismatch:{req.Kind}: expected {req.CountPerArticle}, got {count}");
            }
        }

        // Check relation kinds
        var presentRelations = graph.Relations.Select(r => r.Kind).ToHashSet();
        foreach (ArticleScaleRelationKind expectedRel in contract.Relations)
        {
            if (!presentRelations.Contains(expectedRel))
            {
                violations.Add($"article_relation_missing:{expectedRel}");
            }
        }

        // Check pointer kinds
        var presentPointers = graph.Pointers.Select(p => p.Kind).ToHashSet();
        foreach (ArticleScalePointerRequirement expectedPtr in contract.Pointers)
        {
            if (!presentPointers.Contains(expectedPtr.Kind))
            {
                violations.Add($"article_pointer_missing:{expectedPtr.Kind}");
            }
        }

        // Check for duplicate semantic IDs
        var duplicateIds = graph.Rows.GroupBy(r => r.SemanticId).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        foreach (string dup in duplicateIds)
        {
            violations.Add($"duplicate_semantic_id:{dup}");
        }

        var knownSemanticIds = graph.Rows.Select(r => r.SemanticId).ToHashSet(StringComparer.Ordinal);
        string edgesContractId = $"{prefix}:edges";
        foreach (ArticleScaleRelationPlan rel in graph.Relations)
        {
            if (!knownSemanticIds.Contains(rel.SourceSemanticId))
            {
                violations.Add($"relation_source_missing:{rel.Kind}:{rel.SourceSemanticId}");
            }
            if (!knownSemanticIds.Contains(rel.TargetSemanticId) && rel.TargetSemanticId != edgesContractId)
            {
                violations.Add($"relation_target_missing:{rel.Kind}:{rel.TargetSemanticId}");
            }
        }

        // Check pointer targets
        foreach (ArticleScalePointerPlan ptr in graph.Pointers)
        {
            if (string.IsNullOrWhiteSpace(ptr.TargetSemanticId))
            {
                violations.Add($"pointer_target_empty:{ptr.Kind}");
            }
            else if (ptr.TargetSemanticId.StartsWith(prefix, StringComparison.Ordinal))
            {
                if (!knownSemanticIds.Contains(ptr.TargetSemanticId))
                {
                    violations.Add($"pointer_target_row_missing:{ptr.Kind}:{ptr.TargetSemanticId}");
                }
            }
            else if (!DateTime.TryParse(ptr.TargetSemanticId, null, System.Globalization.DateTimeStyles.RoundtripKind, out _))
            {
                violations.Add($"pointer_target_invalid_timestamp:{ptr.Kind}:{ptr.TargetSemanticId}");
            }
        }

        foreach (ArticleScaleRowPlan block in graph.Rows.Where(
            row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock))
        {
            if (!block.Fields.TryGetValue("MarkdownContent", out object? markdown)
                || markdown is not string content)
            {
                violations.Add($"content_block_markdown_missing:{block.SemanticId}");
                continue;
            }

            ArticleRevisionContentAddress address = ArticleRevisionContentAddress.Compute(content);
            if (!block.Fields.TryGetValue("ContentHash", out object? hash)
                || hash is not string actualHash
                || !string.Equals(address.ContentHash, actualHash, StringComparison.Ordinal))
            {
                violations.Add($"content_block_hash_mismatch:{block.SemanticId}");
            }
            if (!block.Fields.TryGetValue("ByteLength", out object? length)
                || length is not int actualLength
                || address.ByteLength != actualLength)
            {
                violations.Add($"content_block_byte_length_mismatch:{block.SemanticId}");
            }
        }

        // Check rights snapshot hashes (no "recompute" sentinel)
        foreach (ArticleScaleRowPlan rightsRow in graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleRightsSnapshot))
        {
            string? policyHash = rightsRow.Fields.TryGetValue("PolicyHash", out object? p) ? p as string : null;
            string? contentHash = rightsRow.Fields.TryGetValue("ContentCanonicalHash", out object? c) ? c as string : null;

            if (string.IsNullOrEmpty(policyHash) || policyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase))
            {
                violations.Add($"rights_policy_hash_invalid:{rightsRow.SemanticId}");
            }
            if (string.IsNullOrEmpty(contentHash) || contentHash.Contains("recompute", StringComparison.OrdinalIgnoreCase))
            {
                violations.Add($"rights_content_hash_invalid:{rightsRow.SemanticId}");
            }
        }

        // Check outbox payload JSON and production codec compatibility
        foreach (ArticleScaleRowPlan outboxRow in graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope))
        {
            if (!outboxRow.Fields.TryGetValue("PayloadJson", out object? pObj) || pObj is not string payloadJson)
            {
                violations.Add($"outbox_payload_missing:{outboxRow.SemanticId}");
                continue;
            }

            try
            {
                using var doc = JsonDocument.Parse(payloadJson);
                var root = doc.RootElement;
                if (!root.TryGetProperty("articleRevisionId", out _) || !root.TryGetProperty("rightsSnapshotId", out _))
                {
                    violations.Add($"outbox_payload_coordinates_missing:{outboxRow.SemanticId}");
                }
            }
            catch (JsonException)
            {
                violations.Add($"outbox_payload_invalid_json:{outboxRow.SemanticId}");
            }

            // Verify with production codec
            try
            {
                var evt = new ArticleMutationOutboxEvent
                {
                    EventId = outboxRow.Fields.TryGetValue("EventId", out object? eId) ? (string)eId! : string.Empty,
                    AggregateId = outboxRow.Fields.TryGetValue("AggregateId", out object? aggId) ? (int)aggId! : 0,
                    SchemaVersion = outboxRow.Fields.TryGetValue("SchemaVersion", out object? sv) ? (int)sv! : 0,
                    ArticleRevisionId = outboxRow.Fields.TryGetValue("ArticleRevisionId", out object? arid) ? (long?)arid : null,
                    RevisionNo = outboxRow.Fields.TryGetValue("RevisionNo", out object? rno) ? (int?)rno : null,
                    RightsSnapshotId = outboxRow.Fields.TryGetValue("RightsSnapshotId", out object? rsid) ? (long?)rsid : null,
                    ResponsibilitySnapshotId = outboxRow.Fields.TryGetValue("ResponsibilitySnapshotId", out object? respid) ? (long?)respid : null,
                    ResponsibilityVersion = outboxRow.Fields.TryGetValue("ResponsibilityVersion", out object? respv) ? (int?)respv : null,
                    ArticlePublicationId = outboxRow.Fields.TryGetValue("ArticlePublicationId", out object? apid) ? (long?)apid : null,
                    PublicationNo = outboxRow.Fields.TryGetValue("PublicationNo", out object? pno) ? (int?)pno : null,
                    EventType = outboxRow.Fields.TryGetValue("EventType", out object? et) ? (string)et! : string.Empty,
                    PayloadJson = payloadJson,
                    CreatedAt = DateTime.Parse((string)outboxRow.Fields["CreatedAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind)
                };

                var envelope = ArticleMutationOutboxEnvelopeCodec.Read(evt);
                if (envelope.SchemaVersion != ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion)
                {
                    violations.Add($"outbox_envelope_version_mismatch:{outboxRow.SemanticId}");
                }
            }
            catch (Exception ex)
            {
                violations.Add($"outbox_envelope_codec_rejected:{outboxRow.SemanticId}:{ex.Message}");
            }
        }

        // Check recomputed article digest
        string recomputedDigest = CanonicalArticleGraphFactory.ComputeArticleDigest(
            graph.SemanticArticleId,
            graph.Variant,
            graph.Rows,
            graph.Relations,
            graph.Pointers);

        if (!string.Equals(recomputedDigest, graph.ArticleDigest, StringComparison.Ordinal))
        {
            violations.Add("article_digest_tamper_detected");
        }

        return new CanonicalArticleGraphVerificationResult(violations.Count == 0, violations);
    }

    public static CanonicalArticleGraphVerificationResult VerifyFullStream(
        ArticleScalePlan plan,
        IEnumerable<ArticleScaleArticleGraph> stream,
        ArticleScaleGraphReceipt receipt,
        int sampleInterval = 10)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(receipt);

        var violations = new List<string>();

        // Verify receipt first
        var receiptResult = VerifyReceipt(plan, receipt);
        violations.AddRange(receiptResult.Violations);

        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        int index = 0;
        int count = 0;

        foreach (ArticleScaleArticleGraph graph in stream)
        {
            count++;
            if (index % sampleInterval == 0)
            {
                var sampleResult = VerifyArticleGraph(plan, graph);
                violations.AddRange(sampleResult.Violations);
            }

            byte[] articleDigestBytes = Encoding.UTF8.GetBytes(graph.ArticleDigest);
            hasher.AppendData(articleDigestBytes);
            index++;
        }

        if (count != plan.ArticleCount)
        {
            violations.Add($"stream_article_count_mismatch: expected {plan.ArticleCount}, got {count}");
        }

        string recomputedGraphDigest = "sha256:" + Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant();
        if (!string.Equals(recomputedGraphDigest, receipt.SemanticGraphDigest, StringComparison.Ordinal))
        {
            violations.Add($"semantic_graph_digest_tamper_detected: expected {receipt.SemanticGraphDigest}, recomputed {recomputedGraphDigest}");
        }

        return new CanonicalArticleGraphVerificationResult(violations.Count == 0, violations);
    }
}
