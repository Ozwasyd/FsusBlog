using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

internal sealed record ArticlePreservationStorageField(string Property, object? Value);
internal sealed record ArticlePreservationLogicalRow(string EntityOwner, ImmutableArray<ArticlePreservationStorageField> Fields);
internal sealed record ArticlePreservationStorageColumn(
    string Name, string PropertyOwner, object? Value, bool IsPrimaryKey, bool IsIdentity, string DataType, bool IsNullable);
internal sealed record ArticlePreservationStorageRow(string Table, string EntityOwner, ImmutableArray<ArticlePreservationStorageColumn> Columns);

// This is an immutable value/column binding, not apply admission. Physical column names
// come exclusively from the invoked current schema owner's complete entity projection.
internal sealed class ArticlePreservationStorageProgram
{
    private const string EntityNamespace = "FsusBlog.Server.Entities.";

    private ArticlePreservationStorageProgram(
        string planDigest, CurrentSchemaIdentity target, string targetArtifactSha,
        ImmutableArray<ArticlePreservationStorageRow> rows)
    {
        PlanDigest = planDigest;
        Target = target;
        TargetArtifactSha = targetArtifactSha;
        Rows = rows;
    }

    internal string PlanDigest { get; }
    internal CurrentSchemaIdentity Target { get; }
    internal string TargetArtifactSha { get; }
    internal ImmutableArray<ArticlePreservationStorageRow> Rows { get; }

    internal static ArticlePreservationStorageProgram Compile(
        ArticlePreservationWritePlan plan, OwnedCurrentSchemaTarget ownedTarget,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ownedTarget);
        cancellationToken.ThrowIfCancellationRequested();
        ImmutableArray<ArticlePreservationLogicalRow> logical = BuildLogicalRows(plan, cancellationToken);
        CurrentSchemaBootstrapInput input = ownedTarget.ReadBoundInput();
        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach (SchemaTableModel table in input.EntityProjection.Schema.Tables.Values)
        {
            if (table.Owner is null || !tables.TryAdd(table.Owner.Owner, table))
                throw new InvalidOperationException("article_preservation_current_table_owner_ambiguous");
        }
        var rows = ImmutableArray.CreateBuilder<ArticlePreservationStorageRow>(logical.Length);
        var primaryKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticlePreservationLogicalRow row in logical)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!tables.TryGetValue(row.EntityOwner, out SchemaTableModel? table))
                throw new InvalidOperationException("article_preservation_current_table_owner_missing");
            ArticlePreservationStorageRow bound = BindRow(table, row);
            string key = ArticlePreservationSemanticReceipt.Digest("article-storage-primary-key-v1", new
            {
                bound.EntityOwner,
                Key = bound.Columns.Where(static column => column.IsPrimaryKey).ToImmutableArray()
            });
            if (!primaryKeys.Add(key)) throw new InvalidOperationException("article_preservation_current_primary_key_collision");
            rows.Add(bound);
        }
        return new(plan.ContentDigest, ownedTarget.Target, ownedTarget.Execution.ArtifactSha256, rows.ToImmutable());
    }

    // Separate pure function for field-closure regression tests. It does not construct
    // the executable program or replace the production OwnedCurrentSchemaTarget input.
    internal static ArticlePreservationStorageRow BindRow(SchemaTableModel table, ArticlePreservationLogicalRow row)
    {
        if (table.Owner?.Owner != row.EntityOwner || row.Fields.IsDefaultOrEmpty || table.Columns.Count != row.Fields.Length
            || string.IsNullOrWhiteSpace(table.Name) || table.Name.Any(char.IsControl))
            throw new InvalidOperationException("article_preservation_current_row_shape_changed");
        var fields = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (ArticlePreservationStorageField field in row.Fields)
            if (string.IsNullOrWhiteSpace(field.Property) || !fields.TryAdd(row.EntityOwner + "." + field.Property, field.Value))
                throw new InvalidOperationException("article_preservation_current_property_duplicate");
        var owners = new HashSet<string>(StringComparer.Ordinal);
        var columns = ImmutableArray.CreateBuilder<ArticlePreservationStorageColumn>(row.Fields.Length);
        foreach ((string key, SchemaColumnModel column) in table.Columns.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            if (key != column.Name || string.IsNullOrWhiteSpace(column.Name) || column.Name.Any(char.IsControl)
                || column.Owner is null || !owners.Add(column.Owner.Owner)
                || !fields.TryGetValue(column.Owner.Owner, out object? value)
                || column.ComputedExpression is not null || column.Conversion is not (null or "none")
                || (value is null && !column.IsNullable)
                || (value is string text && column.MaxLength is > 0 && text.Length > column.MaxLength.Value)
                || !ValueMatches(column.DataType, value))
                throw new InvalidOperationException("article_preservation_current_column_binding_changed");
            columns.Add(new(column.Name, column.Owner.Owner, value, column.IsPrimaryKey, column.IsIdentity, column.DataType, column.IsNullable));
        }
        if (!columns.Any(static column => column.IsPrimaryKey))
            throw new InvalidOperationException("article_preservation_current_primary_key_missing");
        return new(table.Name, row.EntityOwner, columns.ToImmutable());
    }

    internal static ImmutableArray<ArticlePreservationLogicalRow> BuildLogicalRows(
        ArticlePreservationWritePlan plan, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        cancellationToken.ThrowIfCancellationRequested();
        if (plan.ContentDigest != ArticlePreservationSemanticReceipt.ComputePlanDigest(plan)
            || plan.Articles.IsDefault || plan.Categories.IsDefault || plan.Tags.IsDefault)
            throw new InvalidOperationException("article_preservation_storage_plan_binding");
        var rows = ImmutableArray.CreateBuilder<ArticlePreservationLogicalRow>();
        foreach (ArticlePreservationTaxonomyMap category in plan.Categories.OrderBy(static value => value.TargetId))
            rows.Add(Row("Category", F("Id", category.TargetId), F("Name", category.TargetName), F("Description", null)));
        foreach (ArticlePreservationTaxonomyMap tag in plan.Tags.OrderBy(static value => value.TargetId))
            rows.Add(Row("Tag", F("Id", tag.TargetId), F("Name", tag.TargetName), F("Description", null)));
        var blocks = new Dictionary<long, ArticleRevisionContentAddress>();
        var blockHashes = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (ArticlePreservationArticleWritePlan graph in plan.Articles.OrderBy(static value => value.Source.Id))
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePreservationCurrentData current = graph.Current;
            ArticleCanonicalInput article = current.Article;
            ArticlePreservationGraphCoordinates coordinate = current.Coordinates;
            if (graph.Source.Markdown is null || article.MarkdownContent != graph.Source.Markdown
                || graph.ContentAddress != ArticleRevisionContentAddress.Compute(graph.Source.Markdown)
                || graph.Canonical != ArticleRightsCanonicalBinding.Build(article, current.Rights)
                || article.ArticleId != graph.Source.Id || article.ArticleRevisionId is not > 0 || article.RevisionNo is not > 0
                || coordinate.PublicationId <= 0 || coordinate.PublicationNo <= 0 || coordinate.ContentBlockId <= 0
                || coordinate.RightsPolicyId <= 0 || coordinate.RightsSnapshotId <= 0 || coordinate.ResponsibilitySnapshotId <= 0
                || coordinate.ResponsibilityVersion <= 0 || coordinate.CreatedByAdminPrincipalId < 0)
                throw new InvalidOperationException("article_preservation_storage_graph_binding");
            long revision = article.ArticleRevisionId.Value;
            int revisionNo = article.RevisionNo.Value;
            DateTime created = graph.Source.CreateTime;
            rows.Add(Row("Article", F("Id", article.ArticleId), F("Title", article.Title), F("Summary", article.Summary),
                F("CoverImageUrl", article.CoverImageUrl), F("CategoryId", article.CategoryId), F("Views", ArticleCurrentPolicyDefaults.InitialLiveViews),
                F("CreateTime", created), F("MetadataUpdatedAt", created), F("Status", article.Status),
                F("ScheduledPublishAt", article.ScheduledPublishAt), F("PublishedAt", article.PublishedAt),
                F("LastPublishedAt", article.PublishedAt), F("PublicUpdatedAt", article.PublishedAt),
                F("CurrentRevisionId", revision), F("CurrentPublicationId", coordinate.PublicationId),
                F("PendingPublicationAt", null), F("ArchivedAt", null), F("DeletedAt", null), F("IsDeleted", graph.Source.IsDeleted)));
            rows.Add(Row("ArticleBody", F("ArticleId", article.ArticleId), F("MarkdownContent", graph.Source.Markdown), F("UpdatedAt", created)));
            if (blocks.TryGetValue(coordinate.ContentBlockId, out ArticleRevisionContentAddress previous))
            {
                if (previous != graph.ContentAddress) throw new InvalidOperationException("article_preservation_storage_content_block_collision");
            }
            else
            {
                if (blockHashes.TryGetValue(graph.ContentAddress.ContentHash, out long originalId)
                    && originalId != coordinate.ContentBlockId)
                    throw new InvalidOperationException("article_preservation_storage_content_block_split");
                blocks.Add(coordinate.ContentBlockId, graph.ContentAddress);
                blockHashes.Add(graph.ContentAddress.ContentHash, coordinate.ContentBlockId);
                rows.Add(Row("ArticleRevisionContentBlock", F("Id", coordinate.ContentBlockId), F("ContentHash", graph.ContentAddress.ContentHash),
                    F("MarkdownContent", graph.ContentAddress.MarkdownContent), F("ByteLength", graph.ContentAddress.ByteLength), F("CreatedAt", created)));
            }
            rows.Add(Row("ArticleRevision", F("Id", revision), F("ArticleId", article.ArticleId), F("RevisionNo", revisionNo),
                F("Title", article.Title), F("Summary", article.Summary), F("CoverImageUrl", article.CoverImageUrl), F("CategoryId", article.CategoryId),
                F("TagIds", ArticleRevisionStorageEncoding.EncodeTagIds(article.TagIds)), F("ContentBlockId", coordinate.ContentBlockId),
                F("MarkdownContent", string.Empty), F("DiffSummary", coordinate.DiffSummary), F("CreatedByAdminPrincipalId", coordinate.CreatedByAdminPrincipalId),
                F("RollbackSourceRevisionId", null), F("RollbackReason", null), F("CreatedAt", created)));
            ImmutableArray<ArticlePreservationStorageField> rights = Rights(current.Rights);
            rows.Add(new(EntityNamespace + "ArticleRightsPolicy", [F("Id", coordinate.RightsPolicyId), F("ArticleId", article.ArticleId),
                .. rights, F("CreatedAt", created), F("UpdatedAt", created)]));
            rows.Add(new(EntityNamespace + "ArticleRightsSnapshot", [F("Id", coordinate.RightsSnapshotId), F("ArticleId", article.ArticleId),
                F("ArticleRevisionId", revision), F("RevisionNo", revisionNo), F("ArticleRightsPolicyId", coordinate.RightsPolicyId), .. rights,
                F("CanonicalUrl", graph.Canonical.Rights.CanonicalUrl), F("PolicyHash", graph.Canonical.PolicyHash),
                F("ContentCanonicalHash", graph.Canonical.ContentCanonicalHash), F("CreatedAt", created)]));
            ArticleResponsibilityDraft responsibility = current.Responsibility;
            ArticleResponsibilityStorageEncoding encoded = ArticleResponsibilityStorageEncoding.Encode(responsibility);
            rows.Add(Row("ArticleResponsibilitySnapshot", F("Id", coordinate.ResponsibilitySnapshotId), F("ArticleId", article.ArticleId),
                F("ArticleRevisionId", revision), F("RevisionNo", revisionNo), F("ResponsibilityVersion", coordinate.ResponsibilityVersion),
                F("PreviousSnapshotId", null), F("InheritSiteAuthor", responsibility.InheritSiteAuthor), F("AuthorsJson", encoded.AuthorsJson),
                F("ReviewerJson", encoded.ReviewerJson), F("SourcesJson", encoded.SourcesJson), F("UpdateSummary", responsibility.UpdateSummary),
                F("UpdateReason", responsibility.UpdateReason), F("EffectiveAt", responsibility.EffectiveAt), F("ConclusionImpact", responsibility.ConclusionImpact),
                F("Methodology", responsibility.Methodology), F("Applicability", responsibility.Applicability), F("Limitations", responsibility.Limitations),
                F("ResponsiblePersonConfirmed", responsibility.ResponsiblePersonConfirmed), F("CreatedAt", created)));
            rows.Add(Row("ArticlePublicationRecord", F("Id", coordinate.PublicationId), F("ArticleId", article.ArticleId),
                F("PublicationNo", coordinate.PublicationNo), F("ArticleRevisionId", revision), F("RevisionNo", revisionNo),
                F("RightsSnapshotId", coordinate.RightsSnapshotId), F("ResponsibilitySnapshotId", coordinate.ResponsibilitySnapshotId),
                F("TransitionKind", coordinate.PublicationTransitionKind), F("PublishedAt", coordinate.PublicationTime), F("CreatedAt", created)));
            foreach (int tagId in article.TagIds.Order())
                rows.Add(Row("ArticleTag", F("ArticleId", article.ArticleId), F("TagId", tagId)));
        }
        return rows.ToImmutable();
    }

    internal static ImmutableArray<ArticlePreservationStorageRow> CompileOutbox(
        ArticlePreservationWritePlan plan, ArticlePreservationOutboxBatch batch,
        OwnedCurrentSchemaTarget ownedTarget, CancellationToken token)
    {
        SchemaTableModel table = ownedTarget.ReadBoundInput().EntityProjection.Schema.Tables.Values
            .Single(static table => table.Owner?.Owner == EntityNamespace + "ArticleMutationOutboxEvent");
        return BindOutboxRows(table, plan, batch, token);
    }

    // Pure closed owner binding, also used by native provider contract controls.
    // These values alone grant no source ownership or transaction capability.
    internal static ImmutableArray<ArticlePreservationStorageRow> BindOutboxRows(
        SchemaTableModel table, ArticlePreservationWritePlan plan, ArticlePreservationOutboxBatch batch,
        CancellationToken token)
    {
        _ = BuildLogicalRows(plan, token); // Preserve every original graph/plan oracle.
        if (batch.PlanDigest != plan.ContentDigest || batch.Events.IsDefault
            || batch.Events.Length != plan.Articles.Length
            || batch.Events.Select(static item => item.ArticleId).Distinct().Count() != batch.Events.Length
            || batch.Events.Select(static item => item.EventId).Distinct(StringComparer.Ordinal).Count() != batch.Events.Length)
            throw new InvalidOperationException("article_preservation_outbox_batch_binding");
        var result = ImmutableArray.CreateBuilder<ArticlePreservationStorageRow>();
        foreach (ArticlePreservationOutboxEnvelope envelope in batch.Events.OrderBy(static item => item.ArticleId))
        {
            token.ThrowIfCancellationRequested();
            ArticlePreservationArticleWritePlan graph = plan.Articles.Single(item => item.Source.Id == envelope.ArticleId);
            RequireEnvelope(graph, envelope);
            var coordinate = graph.Current.Coordinates;
            DateTime occurred = DateTime.SpecifyKind(envelope.OccurredAt, DateTimeKind.Unspecified);
            ArticlePreservationStorageRow row = BindRow(table, Row("ArticleMutationOutboxEvent",
                F("Id", 0L), F("EventId", envelope.EventId), F("AggregateType", "article"), F("AggregateId", envelope.ArticleId),
                F("SchemaVersion", 2), F("ArticleRevisionId", graph.Current.Article.ArticleRevisionId!.Value),
                F("RevisionNo", graph.Current.Article.RevisionNo!.Value), F("RightsSnapshotId", coordinate.RightsSnapshotId),
                F("ResponsibilitySnapshotId", coordinate.ResponsibilitySnapshotId), F("ResponsibilityVersion", coordinate.ResponsibilityVersion),
                F("ArticlePublicationId", coordinate.PublicationId), F("PublicationNo", coordinate.PublicationNo),
                F("EventType", "created"), F("PayloadJson", envelope.PayloadJson), F("Status", "pending"), F("RetryCount", 0),
                F("NextRetryAt", occurred), F("CreatedAt", occurred), F("ProcessedAt", null), F("LastError", null),
                F("ClaimToken", null), F("ClaimedBy", null), F("ClaimedAt", null), F("HeartbeatAt", null), F("ClaimExpiresAt", null)));
            if (row.Columns.Count(static column => column.IsPrimaryKey) != 1
                || row.Columns.Count(static column => column.IsIdentity) != 1
                || !row.Columns.Any(static column => column.IsPrimaryKey && column.IsIdentity
                    && column.DataType == "int64" && column.PropertyOwner == EntityNamespace + "ArticleMutationOutboxEvent.Id"))
                throw new InvalidOperationException("article_preservation_outbox_identity_owner_changed");
            result.Add(row);
        }
        return result.ToImmutable();
    }

    private static void RequireEnvelope(ArticlePreservationArticleWritePlan graph, ArticlePreservationOutboxEnvelope envelope)
    {
        if (!Guid.TryParseExact(envelope.EventId, "N", out Guid id) || id == Guid.Empty
            || envelope.OccurredAt.Kind != DateTimeKind.Utc || envelope.OccurredAt.Ticks % 10 != 0
            || string.IsNullOrWhiteSpace(envelope.PayloadJson))
            throw new InvalidOperationException("article_preservation_outbox_original_envelope_required");
        using JsonDocument document = JsonDocument.Parse(envelope.PayloadJson);
        JsonElement root = document.RootElement;
        RequireUniqueProperties(root);
        var article = graph.Current.Article;
        var coordinate = graph.Current.Coordinates;
        bool Integer(string name, long value) => root.TryGetProperty(name, out var actual)
            && actual.TryGetInt64(out long number) && number == value;
        bool Time(string name, DateTime expected) => root.TryGetProperty(name, out var actual)
            && actual.ValueKind == JsonValueKind.String
            && DateTime.TryParse(actual.GetString(), CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out DateTime value)
            && value == DateTime.SpecifyKind(expected, DateTimeKind.Utc);
        if (root.ValueKind != JsonValueKind.Object || !Integer("schemaVersion", 2)
            || !Integer("articleId", article.ArticleId) || root.GetProperty("eventType").GetString() != "created"
            || !Integer("articleRevisionId", article.ArticleRevisionId!.Value) || !Integer("revisionNo", article.RevisionNo!.Value)
            || !Integer("rightsSnapshotId", coordinate.RightsSnapshotId)
            || !Integer("responsibilitySnapshotId", coordinate.ResponsibilitySnapshotId)
            || !Integer("responsibilityVersion", coordinate.ResponsibilityVersion)
            || !Integer("releaseId", coordinate.PublicationId) || !Integer("releaseNo", coordinate.PublicationNo)
            || !Time("occurredAt", envelope.OccurredAt)
            || !Time("publicUpdatedAt", article.PublishedAt ?? envelope.OccurredAt)
            || root.TryGetProperty("articlePublicationId", out _) || root.TryGetProperty("publicationNo", out _))
            throw new InvalidOperationException("article_preservation_outbox_envelope_coordinates_changed");
        string visibility = graph.Source.IsDeleted || article.Status == ArticleStatusValues.Deleted ? "deleted"
            : article.Status switch
            {
                ArticleStatusValues.Published => "published",
                ArticleStatusValues.Scheduled => "scheduled",
                ArticleStatusValues.Archived => "archived",
                _ => "draft"
            };
        void RequireScope(JsonElement scope)
        {
            if (scope.ValueKind != JsonValueKind.Object || scope.GetProperty("categoryId").GetInt32() != article.CategoryId
                || scope.GetProperty("visibility").GetString() != visibility
                || !scope.GetProperty("tagIds").EnumerateArray().Select(static tag => tag.GetInt32()).SequenceEqual(article.TagIds.Order()))
                throw new InvalidOperationException("article_preservation_outbox_envelope_scope_changed");
        }
        RequireScope(root.GetProperty("after"));
        JsonElement before = root.GetProperty("before");
        if (before.ValueKind != JsonValueKind.Null)
            RequireScope(before);
    }

    private static void RequireUniqueProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw new InvalidOperationException("article_preservation_outbox_duplicate_property");
                RequireUniqueProperties(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (JsonElement item in value.EnumerateArray())
                RequireUniqueProperties(item);
    }

    private static ArticlePreservationStorageField F(string property, object? value) => new(property, value);
    internal static bool ValueMatches(string type, object? value)
        => type switch
        {
            "string" => value is null or string,
            "int32" => value is null or int,
            "int64" => value is null or long,
            "boolean" => value is null or bool,
            "timestamp" => value is null or DateTime,
            _ => false
        };
    private static ArticlePreservationLogicalRow Row(string entity, params ArticlePreservationStorageField[] fields)
        => new(EntityNamespace + entity, fields.ToImmutableArray());
    private static ImmutableArray<ArticlePreservationStorageField> Rights(ArticleRightsNormalizedModel rights)
        => [F("Enabled", rights.Enabled), F("LicenseType", rights.LicenseType), F("CopyrightHolder", rights.CopyrightHolder),
            F("CopyrightYear", rights.CopyrightYear), F("RightsStatement", rights.RightsStatement), F("AttributionTemplate", rights.AttributionTemplate),
            F("CopyPolicy", rights.CopyPolicy), F("MaxExcerptChars", rights.MaxExcerptChars), F("AllowCodeCopy", rights.AllowCodeCopy),
            F("ShowPublicBadge", rights.ShowPublicBadge), F("ProofBindingEnabled", rights.ProofBindingEnabled)];
}
