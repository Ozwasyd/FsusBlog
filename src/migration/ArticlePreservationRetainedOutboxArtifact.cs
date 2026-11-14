using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// Migration-owned retained data, not a canonical event issuer or an admission grant.
// The canonical owner must issue EventId/PayloadJson/OccurredAt; no constructor here
// authenticates their provenance. Recovery additionally requires original journal custody.
internal sealed record ArticlePreservationOutboxArtifactBinding(
    CurrentSchemaArtifactReference PlanArtifact,
    string PlanDigest,
    string ArticlePlanDigest,
    CurrentSchemaArtifactReference SourceExport,
    CurrentSchemaArtifactReference CurrentExport,
    string FullSourceContentDigest,
    CurrentSchemaVerifierIdentity Tool,
    OfflineMigrationProviderOperation Operation,
    string InvocationId,
    CurrentSchemaDatabaseIdentity Database);

internal sealed record ArticlePreservationOutboxArtifactLimits(
    long MaximumBytes, int MaximumEvents, long MaximumPayloadBytes);

internal sealed record ArticlePreservationRetainedOutboxData(
    string Format, ArticlePreservationOutboxArtifactBinding Binding,
    CurrentSchemaProducerIdentity Issuer, ArticlePreservationOutboxBatch Batch);

internal sealed record ArticlePreservationRetainedOutboxCandidate(
    CurrentSchemaArtifactReference Artifact, ArticlePreservationRetainedOutboxData Data);

internal sealed record ArticlePreservationOutboxReceiptData(
    string Format, ArticlePreservationOutboxArtifactBinding Binding,
    CurrentSchemaArtifactReference IssuedBatch,
    ImmutableArray<ArticlePreservationOutboxReceipt> Receipts);

// Exact artifact verification is integrity, not proof of a canonical factory call.
// There is deliberately no public/raw-data method minting a trusted issued batch.
internal static class ArticlePreservationRetainedOutboxArtifact
{
    internal const string Format = "fsusblog.article-preservation-issued-outbox.v1";
    internal const string ReceiptFormat = "fsusblog.article-preservation-outbox-receipt.v1";
    internal const string CanonicalFactoryId = "fsusblog.article-mutation-outbox-producer.v1";
    internal const string IssuedReferenceFact = "outbox.issued_artifact.reference";
    internal const string IssuedDigestFact = "outbox.issued_artifact.sha256";
    internal const string ReceiptReferenceFact = "outbox.receipt_artifact.reference";
    internal const string ReceiptDigestFact = "outbox.receipt_artifact.sha256";
    internal const int MaximumInlineEvents = (256 - 4) / 2;

    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 32
    };
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    internal static async Task<ArticlePreservationRetainedOutboxCandidate> ReadCandidateAsync(
        CurrentSchemaArtifactReference reference, ArticlePreservationOutboxArtifactBinding expected,
        CurrentSchemaProducerIdentity expectedIssuer, ImmutableArray<int> expectedArticles,
        ArticlePreservationOutboxArtifactLimits limits, CancellationToken token)
    {
        RequireLimits(limits);
        RequireReference(reference);
        // Original native regular-file/identity/hash/size reader; not File.ReadAllText,
        // a caller byte seal, newest file, directory scan or post-commit regeneration.
        ImmutableArray<byte> bytes = await PgArticlePreservationOperation.ReadArtifactAsync(
            reference, limits.MaximumBytes, token).ConfigureAwait(false);
        ArticlePreservationRetainedOutboxData data = ParseCandidate(bytes.AsSpan(), expected,
            expectedIssuer, expectedArticles, limits);
        return new(reference, data);
    }

    // Pure verification exposed for untrusted-artifact controls. The result remains data.
    internal static ArticlePreservationRetainedOutboxData ParseCandidate(
        ReadOnlySpan<byte> bytes, ArticlePreservationOutboxArtifactBinding expected,
        CurrentSchemaProducerIdentity expectedIssuer, ImmutableArray<int> expectedArticles,
        ArticlePreservationOutboxArtifactLimits limits)
    {
        RequireLimits(limits);
        RequireBinding(expected);
        RequireExpectedArticles(expectedArticles, limits);
        RequireIssuer(expectedIssuer, expected);
        RequireByteCount(bytes.Length, limits);
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes.ToArray(), new()
            {
                MaxDepth = 32
            });
            RequireUniqueProperties(document.RootElement);
            JsonElement events = document.RootElement.GetProperty("Batch").GetProperty("Events");
            if (events.ValueKind != JsonValueKind.Array || events.GetArrayLength() != expectedArticles.Length
                || events.GetArrayLength() > limits.MaximumEvents)
                throw Invalid("event_count");
            ArticlePreservationRetainedOutboxData data = JsonSerializer.Deserialize<ArticlePreservationRetainedOutboxData>(bytes, s_json)
                ?? throw Invalid("empty");
            if (data.Format != Format || data.Binding != expected || data.Issuer != expectedIssuer
                || data.Batch is null || data.Batch.PlanDigest != expected.ArticlePlanDigest
                || data.Batch.Events.IsDefault || data.Batch.Events.Length != expectedArticles.Length)
                throw Invalid("binding_changed");
            var articles = new HashSet<int>();
            var eventsSeen = new HashSet<string>(StringComparer.Ordinal);
            long payloadBytes = 0;
            foreach (ArticlePreservationOutboxEnvelope item in data.Batch.Events)
            {
                if (item is null || item.ArticleId <= 0 || !articles.Add(item.ArticleId)
                    || !Guid.TryParseExact(item.EventId, "N", out Guid id) || id == Guid.Empty
                    || !eventsSeen.Add(item.EventId) || item.OccurredAt.Kind != DateTimeKind.Utc
                    || item.OccurredAt.Ticks % 10 != 0 || string.IsNullOrWhiteSpace(item.PayloadJson))
                    throw Invalid("event_identity_changed");
                payloadBytes = checked(payloadBytes + s_utf8.GetByteCount(item.PayloadJson));
                if (payloadBytes > limits.MaximumPayloadBytes)
                    throw Invalid("payload_budget_exceeded");
            }
            if (!articles.SetEquals(expectedArticles))
                throw Invalid("article_roster_changed");
            // The Migration envelope is canonical retained data; payload strings are never
            // parsed/reformatted here. Original graph/codec validation still runs at staging.
            if (!bytes.SequenceEqual(SerializeCandidate(data)))
                throw Invalid("noncanonical_bytes");
            return data;
        }
        catch (Exception failure) when (failure is JsonException or KeyNotFoundException or InvalidCastException
            or ArgumentException or OverflowException)
        {
            throw Invalid("invalid_json_or_value"); // No private payload/parser text crosses this port.
        }
    }

    internal static byte[] SerializeCandidate(ArticlePreservationRetainedOutboxData data)
        => JsonSerializer.SerializeToUtf8Bytes(data, s_json);

    internal static ImmutableArray<OfflineMigrationFact> IssuedFacts(CurrentSchemaArtifactReference reference)
    {
        RequireReference(reference);
        return [new(IssuedReferenceFact, reference.Reference), new(IssuedDigestFact, reference.Sha256)];
    }

    // Called only after the original operation selected its exact verified committed unit.
    // These facts are locators from that unit, not authority supplied by a plan/CLI DTO.
    internal static CurrentSchemaArtifactReference? ReadRecordedReference(
        OfflineMigrationPredicateObservation observation, string referenceName, string digestName)
    {
        if (observation.ExpectedFacts.IsDefault || observation.ActualFacts.IsDefault
            || !observation.ExpectedFacts.SequenceEqual(observation.ActualFacts)
            || observation.ContentDigest != OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation))
            throw Invalid("journal_observation_changed");
        OfflineMigrationFact[] references = observation.ActualFacts.Where(fact => fact.Name == referenceName).ToArray();
        OfflineMigrationFact[] digests = observation.ActualFacts.Where(fact => fact.Name == digestName).ToArray();
        if (references.Length == 0 && digests.Length == 0)
            return null;
        if (references.Length != 1 || digests.Length != 1)
            throw Invalid("journal_reference_ambiguous");
        var reference = new CurrentSchemaArtifactReference(references[0].Value, digests[0].Value);
        RequireReference(reference);
        return reference;
    }

    internal static async Task<CurrentSchemaArtifactReference> PublishReceiptAsync(
        string absoluteDirectory, ArticlePreservationRetainedOutboxCandidate issued,
        ImmutableArray<ArticlePreservationOutboxReceipt> actualReceipts,
        ArticlePreservationOutboxArtifactLimits limits, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        RequireLimits(limits);
        RequireReference(issued.Artifact);
        RequireReceipts(issued.Data, actualReceipts, limits);
        if (!Path.IsPathFullyQualified(absoluteDirectory) || Path.GetFullPath(absoluteDirectory) != absoluteDirectory
            || absoluteDirectory.Any(char.IsControl) || !Directory.Exists(absoluteDirectory))
            throw Invalid("receipt_directory_required");
        var data = new ArticlePreservationOutboxReceiptData(ReceiptFormat, issued.Data.Binding,
            issued.Artifact, actualReceipts.OrderBy(static receipt => receipt.ArticleId).ToImmutableArray());
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(data, s_json);
        RequireByteCount(bytes.Length, limits);
        string digest = ArticlePreservationSemanticReceipt.HashBytes(bytes);
        string path = Path.Combine(absoluteDirectory, "article-outbox-receipt-" + digest + ".json");
        var reference = new CurrentSchemaArtifactReference(path, digest);
        RequireReference(reference);
        if (!File.Exists(path))
        {
            CurrentSchemaArtifactReference actual = await OfflineMigrationArtifactPublisher.PublishAsync(path, bytes, token).ConfigureAwait(false);
            if (actual != reference)
                throw Invalid("receipt_publication_changed");
        }
        _ = await ReadReceiptAsync(reference, issued, actualReceipts, limits, token).ConfigureAwait(false);
        // This is a transaction-local readback artifact, never a commit acknowledgement.
        return reference;
    }

    internal static async Task<ArticlePreservationOutboxReceiptData> ReadReceiptAsync(
        CurrentSchemaArtifactReference reference, ArticlePreservationRetainedOutboxCandidate issued,
        ImmutableArray<ArticlePreservationOutboxReceipt> actualReceipts,
        ArticlePreservationOutboxArtifactLimits limits, CancellationToken token)
    {
        RequireLimits(limits);
        RequireReference(reference);
        RequireReceipts(issued.Data, actualReceipts, limits);
        ImmutableArray<byte> bytes = await PgArticlePreservationOperation.ReadArtifactAsync(
            reference, limits.MaximumBytes, token).ConfigureAwait(false);
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes.AsMemory(), new()
            {
                MaxDepth = 32
            });
            RequireUniqueProperties(document.RootElement);
            JsonElement rows = document.RootElement.GetProperty("Receipts");
            if (rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > limits.MaximumEvents
                || rows.GetArrayLength() != actualReceipts.Length)
                throw Invalid("receipt_roster_changed");
            var data = JsonSerializer.Deserialize<ArticlePreservationOutboxReceiptData>(bytes.AsSpan(), s_json)
                ?? throw Invalid("receipt_empty");
            if (data.Format != ReceiptFormat || data.Binding != issued.Data.Binding || data.IssuedBatch != issued.Artifact
                || data.Receipts.IsDefault || !data.Receipts.SequenceEqual(actualReceipts.OrderBy(static receipt => receipt.ArticleId))
                || !bytes.AsSpan().SequenceEqual(JsonSerializer.SerializeToUtf8Bytes(data, s_json)))
                throw Invalid("receipt_binding_changed");
            return data;
        }
        catch (Exception failure) when (failure is JsonException or KeyNotFoundException or InvalidCastException
            or ArgumentException or OverflowException)
        {
            throw Invalid("receipt_invalid_json_or_value");
        }
    }

    internal static ImmutableArray<OfflineMigrationFact> ReceiptFacts(CurrentSchemaArtifactReference reference)
    {
        RequireReference(reference);
        return [new(ReceiptReferenceFact, reference.Reference), new(ReceiptDigestFact, reference.Sha256)];
    }

    private static void RequireReceipts(ArticlePreservationRetainedOutboxData issued,
        ImmutableArray<ArticlePreservationOutboxReceipt> receipts, ArticlePreservationOutboxArtifactLimits limits)
    {
        RequireBinding(issued.Binding);
        if (issued.Batch is null || issued.Batch.Events.IsDefault || receipts.IsDefault
            || receipts.Length != issued.Batch.Events.Length || receipts.Length > limits.MaximumEvents
            || receipts.Any(static receipt => receipt is null)
            || receipts.Select(static receipt => receipt.ArticleId).Distinct().Count() != receipts.Length
            || receipts.Select(static receipt => receipt.OutboxId).Distinct().Count() != receipts.Length)
            throw Invalid("receipt_roster_changed");
        var events = new Dictionary<int, string>();
        foreach (ArticlePreservationOutboxEnvelope item in issued.Batch.Events)
        {
            if (item is null || item.ArticleId <= 0 || !events.TryAdd(item.ArticleId, item.EventId))
                throw Invalid("receipt_roster_changed");
        }
        foreach (ArticlePreservationOutboxReceipt receipt in receipts)
        {
            if (receipt is null || receipt.OutboxId <= 0 || receipt.ArticleId <= 0
                || !events.TryGetValue(receipt.ArticleId, out string? expectedEventId) || expectedEventId != receipt.EventId)
                throw Invalid("receipt_event_changed");
        }
    }

    private static void RequireBinding(ArticlePreservationOutboxArtifactBinding binding)
    {
        if (binding is null || binding.Tool is null || binding.Operation is null || binding.Database is null
            || string.IsNullOrWhiteSpace(binding.InvocationId) || binding.InvocationId.Length > 160
            || binding.InvocationId.Any(char.IsControl) || binding.Tool.SourceRevision is not { Length: 40 }
            || !binding.Tool.SourceRevision.All(Uri.IsHexDigit))
            throw Invalid("binding_required");
        foreach (CurrentSchemaArtifactReference reference in new[] { binding.PlanArtifact, binding.SourceExport, binding.CurrentExport })
            RequireReference(reference);
        foreach (string digest in new[] { binding.PlanDigest, binding.ArticlePlanDigest, binding.FullSourceContentDigest,
            binding.Tool.WorktreeDigest, binding.Tool.ToolchainDigest, binding.Tool.ConfigurationDigest,
            binding.Operation.OperationSourceDigest, binding.Operation.SemanticDigest })
            if (!ArticlePreservationSemanticReceipt.IsDigest(digest))
                throw Invalid("binding_digest_required");
    }

    private static void RequireIssuer(CurrentSchemaProducerIdentity issuer, ArticlePreservationOutboxArtifactBinding expected)
    {
        if (issuer is null || issuer.ProducerId != CanonicalFactoryId || issuer.SourceCommit != expected.Tool.SourceRevision
            || !ArticlePreservationSemanticReceipt.IsDigest(issuer.ProducerAssemblySha256)
            || !ArticlePreservationSemanticReceipt.IsDigest(issuer.ContractAssemblySha256))
            throw Invalid("canonical_issuer_identity_required");
    }

    private static void RequireExpectedArticles(ImmutableArray<int> articles, ArticlePreservationOutboxArtifactLimits limits)
    {
        if (articles.IsDefault || articles.Length > limits.MaximumEvents || articles.Any(static id => id <= 0)
            || articles.Distinct().Count() != articles.Length)
            throw Invalid("expected_article_roster_required");
    }

    private static void RequireReference(CurrentSchemaArtifactReference reference)
    {
        if (reference is null || string.IsNullOrWhiteSpace(reference.Reference) || reference.Reference.Length > 4096
            || reference.Reference.Any(char.IsControl) || !ArticlePreservationSemanticReceipt.IsDigest(reference.Sha256))
            throw Invalid("exact_artifact_reference_required");
    }

    private static void RequireLimits(ArticlePreservationOutboxArtifactLimits limits)
    {
        if (limits is null || limits.MaximumBytes <= 0 || limits.MaximumEvents <= 0 || limits.MaximumPayloadBytes <= 0)
            throw Invalid("limits_required");
    }

    private static void RequireByteCount(int count, ArticlePreservationOutboxArtifactLimits limits)
    {
        if (count <= 0 || count > limits.MaximumBytes)
            throw Invalid("artifact_byte_budget_exceeded");
    }

    private static void RequireUniqueProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw Invalid("duplicate_property");
                RequireUniqueProperties(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in value.EnumerateArray())
                RequireUniqueProperties(item);
        }
    }

    private static InvalidOperationException Invalid(string suffix)
        => new("article_preservation_retained_outbox_" + suffix);
}
