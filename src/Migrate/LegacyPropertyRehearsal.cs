using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Core.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private sealed record LegacyPropertyReview(int Version, long SourceOwner, string SourceSite, long SourceRevision,
        Guid TargetOwner, Guid TargetSite, long? TargetSchemaRevision, Dictionary<string, string> SourceRelations);
    private sealed record LegacyPropertyCandidate(long Sequence, Guid DefinitionId, string SourceDigest, PropertyTransition Transition);

    private static async Task<int> RehearseLegacyPropertiesAsync(string path, string approvedSha256, CancellationToken ct,
        (string Path, string Sha256)? activation = null)
    {
        if (!Path.IsPathFullyQualified(path) || !IsSha256(approvedSha256))
            throw new ArgumentException("Supply an absolute property review path and its independently approved SHA-256.");
        await using var input = File.OpenRead(path);
        var bytes = await ReadBoundedArtifactAsync(input, 16_384, ct,
            static () => new ArgumentException("Invalid property review size."),
            static () => new ArgumentException("Property review SHA-256 does not match."), approvedSha256);
        LegacyPropertyReview? review;
        try { review = JsonSerializer.Deserialize<LegacyPropertyReview>(bytes, OwnerMapJson); }
        catch (JsonException) { throw new ArgumentException("Invalid property review."); }
        if (review is not { Version: 1, SourceOwner: > 0, SourceRevision: > 0 and <= PropertySchema.MaxDefinitions,
                SourceSite.Length: > 0 and <= 128, TargetSchemaRevision: 0 } ||
            review.SourceSite != review.SourceSite.Trim() || review.SourceSite.Any(char.IsControl) ||
            review.TargetOwner == Guid.Empty || review.TargetSite == Guid.Empty || review.SourceRelations is null ||
            !LegacyPropertyDefinitions.SetEquals(review.SourceRelations.Keys) || review.SourceRelations.Values.Any(hash => !IsSha256(hash)))
            throw new ArgumentException("Invalid property scope, revision, or source relation review.");

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromMinutes(4));
        try
        {
            var backup = activation is { } rollback
                ? await ReadLegacyImportBackupAsync(rollback.Path, rollback.Sha256, budget.Token) : null;
            var proof = await ReplayReviewedPropertyDefinitionsAsync(review, approvedSha256, backup, budget.Token);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                sourceReference = LegacyReference, reviewSha256 = approvedSha256, definitions = proof.Count,
                stagedDefinitionSha256 = proof.Digest, writesApplied = proof.Applied, activationEligible = backup is not null,
                unresolved = new[] { "source-audit-authentication", "select-reference-url-policies", "legacy-property-values", "source-retirement" }
            }, Json));
            return 0;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            Console.Error.WriteLine("The property rehearsal exceeded its read-only snapshot budget.");
            return 2;
        }
        catch (DbException)
        {
            Console.Error.WriteLine("The property rehearsal could not verify the source or target relation shape.");
            return 2;
        }
        catch (PropertySchemaException)
        {
            Console.Error.WriteLine("The approved definition does not satisfy the canonical V2 authority.");
            return 2;
        }
    }

    private static async Task<(int Count, string Digest, bool Applied)> ReplayReviewedPropertyDefinitionsAsync(
        LegacyPropertyReview review, string reviewSha256, ImportBackup? backup, CancellationToken ct)
    {
        var source = ParseLegacySource("postgres");
        await using var donor = source.Connection;
        await donor.OpenAsync(ct);
        await using var sourceSnapshot = await BeginLegacyReadAsync(donor, ct);
        var catalog = await ReadLegacyCatalogAsync(source, sourceSnapshot, ct);
        if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Expected an isolated V1 property source.");
        var inventory = await ReadLegacyPropertyInventoryAsync(source, sourceSnapshot, catalog, ct);
        if (inventory.Count(row => row.RecordedInFrozenDefinitionAuthority) != LegacyPropertyDefinitions.Count ||
            inventory.Any(row => row.RecordedInFrozenDefinitionAuthority
                ? row.PostgreSqlSha256 is null || review.SourceRelations[row.Relation] != row.PostgreSqlSha256
                : row.Rows is null or > 0))
            throw new InvalidOperationException("The frozen property relations changed or include unresolved rows.");

        var targetSettings = backup is null
            ? new NpgsqlConnectionStringBuilder(RequireLegacyValue(DatabaseVariable)) { Pooling = false, Enlist = false }
            : ParseLegacyRuntimeActivationDatabase(DatabaseVariable);
        await using var target = new NpgsqlConnection(targetSettings.ConnectionString);
        await target.OpenAsync(ct);
        if (backup is not null) await RequireBackupDatabaseLockAsync(target, ct);
        await using var targetSnapshot = backup is null ? await BeginReadOnlyAsync(target, ct) :
            await target.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        if (backup is null)
        {
            await CurrentSchema.VerifyCatalogAsync(target, targetSnapshot, ct);
            if (await CurrentSchema.ReadRecoverySiteIdAsync(target, targetSnapshot, ct) != review.TargetSite)
                throw new InvalidOperationException("The reviewed target site does not match.");
            await using var verify = new NpgsqlCommand("""
                select exists (
                    select from public.blog_user u where u.id=$1 and u.can_author and u.enabled
                    and coalesce((select revision from public.property_schema where owner_id=u.id),0)=$2
                    and not exists(select from public.property_definition where owner_id=u.id)
                    and not exists(select from public.property_schema_command where owner_id=u.id))
                """, target, targetSnapshot);
            verify.Parameters.AddWithValue(review.TargetOwner);
            verify.Parameters.AddWithValue(review.TargetSchemaRevision.GetValueOrDefault());
            if (await verify.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("The reviewed target author or empty property schema does not match.");
        }

        string Table(string suffix) => source.Table(catalog.Single(t => t.Name == "article_property_definition" + suffix));
        await using var query = CreateLegacyCommand(sourceSnapshot, $"""
            select d.definition_id,d.machine_key,d.value_type,d.required,d.null_behavior,d.empty_behavior,d.display_placement,
                d.min_length,d.max_length,d.min_number::text,d.max_number::text,d.min_date_utc_ticks,d.max_date_utc_ticks,
                d.content_digest,r.owner_revision,r.request_id,
                array(select n.locale from {Table("_display_name")} n where n.definition_id=d.definition_id order by n.locale collate "C" limit 17),
                array(select n.value from {Table("_display_name")} n where n.definition_id=d.definition_id order by n.locale collate "C" limit 17)
            from {Table("")} d
            join {Table("_owner")} owner using(owner_user_id,site_scope)
            join {Table("_history")} h using(owner_user_id,site_scope)
            join {Table("_receipt")} r on r.definition_id=d.definition_id and r.owner_user_id=d.owner_user_id and r.site_scope=d.site_scope
            join {Table("_command")} c on c.receipt_id=r.receipt_id and c.owner_user_id=r.owner_user_id and c.site_scope=r.site_scope
            join {Table("_idempotency")} i on i.receipt_id=r.receipt_id and i.actor_admin_principal_id=r.actor_admin_principal_id
                and i.request_id=r.request_id and i.command_digest=r.command_digest
            where d.owner_user_id=@owner and d.site_scope=@site and owner.revision=@revision and h.revision=owner.revision
              and h.history_version=1 and c.history_version=1 and c.sequence=r.owner_revision and c.definition_id=d.definition_id
              and c.request_id=r.request_id and c.actor_admin_principal_id=r.actor_admin_principal_id and c.command_kind='create'
              and r.command_kind='create' and r.previous_schema_revision=0 and r.schema_revision=1 and r.status=0
              and d.schema_version=1 and d.status=0 and d.schema_revision=1 and r.after_definition_digest=d.content_digest
              and d.value_type between 0 and 3 and d.cardinality=0 and d.min_items is null and d.max_items is null
              and (select count(*) from {Table("")} all_fields where all_fields.owner_user_id=@owner and all_fields.site_scope=@site)=@revision
              and (select count(*) from {Table("_receipt")} all_receipts where all_receipts.owner_user_id=@owner and all_receipts.site_scope=@site)=@revision
              and (select count(*) from {Table("_command")} all_commands where all_commands.owner_user_id=@owner and all_commands.site_scope=@site)=@revision
              and d.missing_behavior=0 and d.default_kind=0 and d.default_scalar is null
              and d.default_option_ids='' and d.default_article_ids=''
              and d.reference_cardinality is null and d.reference_permission is null and d.allow_cross_site is null
              and d.allow_deleted is null and d.allow_archived is null and d.allow_self_reference is null and d.allow_cycles is null
              and d.url_allowed_schemes='' and d.url_allow_relative is null and d.url_allow_absolute is null
              and d.url_max_length is null and d.url_normalization is null
              and not d.search_eligible and not d.filterable and not d.sortable and d.visibility_scope=0
              and not exists(select from {Table("_obligation")} o where o.receipt_id=r.receipt_id)
              and not exists(select from {Table("_option_label")} l where l.definition_id=d.definition_id)
              and not exists(select from {Table("_option")} o where o.definition_id=d.definition_id)
            order by r.owner_revision limit @limit
            """);
        Add("owner", review.SourceOwner); Add("site", review.SourceSite); Add("revision", review.SourceRevision);
        Add("limit", PropertySchema.MaxDefinitions + 1);
        void Add(string name, object value)
        {
            var parameter = query.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            query.Parameters.Add(parameter);
        }

        var scope = new PropertyScope("primary", review.TargetOwner);
        var schema = new PropertySchema(scope);
        var definitions = new List<PropertyDefinition>();
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, "fsusblog.legacy-property-definition-rehearsal.v1");
        AppendLegacyValue(digest, reviewSha256);
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
            {
                var candidate = ReplayLegacyPropertyDefinition(schema, rows, review.TargetOwner);
                schema = candidate.Transition.Schema;
                var definition = schema.Find(candidate.DefinitionId)!;
                definitions.Add(definition);
                AppendLegacyValue(digest, candidate.Sequence);
                AppendLegacyValue(digest, candidate.SourceDigest);
                AppendLegacyValue(digest, definition.Digest);
                AppendLegacyValue(digest, candidate.Transition.Receipt.CommandDigest);
            }
        }
        // Every approved source coordinate must be representable. There is no partial eligibility.
        if (schema.Revision != review.SourceRevision)
            throw new InvalidOperationException("The reviewed source has unsupported policy, missing provenance, or non-create history.");
        var restored = PropertySchema.Restore(scope, schema.Revision, definitions);
        foreach (var definition in definitions)
            if (restored.Find(definition.Id)?.Digest != definition.Digest)
                throw new InvalidOperationException("The canonical property definition did not round trip.");
        var applied = false;
        if (backup is null)
            await targetSnapshot.RollbackAsync(ct);
        else
        {
            applied = await ActivateLegacyPropertyDefinitionsAsync(target, targetSnapshot, review, backup, definitions, ct);
            await targetSnapshot.CommitAsync(ct);
        }
        await sourceSnapshot.RollbackAsync(ct);
        return (definitions.Count, Convert.ToHexStringLower(digest.GetHashAndReset()), applied);
    }

    private static LegacyPropertyCandidate ReplayLegacyPropertyDefinition(PropertySchema schema, DbDataReader row, Guid owner)
    {
        var id = row.GetGuid(0);
        string key = row.GetString(1);
        var kind = (PropertyKind)row.GetInt16(2);
        var nullBehavior = row.GetInt16(4);
        var emptyBehavior = row.GetInt16(5);
        var placement = (PropertyPlacement)row.GetInt16(6);
        var sourceDigest = row.GetString(13);
        long sequence = row.GetInt64(14);
        var request = row.GetGuid(15);
        if (!IsSha256(sourceDigest) || sequence != schema.Revision + 1 || nullBehavior is < 0 or > 1 ||
            emptyBehavior is < 0 or > 2 || !Enum.IsDefined(placement))
            throw new InvalidOperationException("Invalid legacy property definition coordinates or policy.");

        var names = row.GetFieldValue<string[]>(16).Zip(row.GetFieldValue<string[]>(17), (locale, name) => new PropertyName(locale, name))
            .ToImmutableArray();
        // Preserve both nullable SQL bounds and exact typed decimal/UTC representations.
        var settings = new PropertySettings(kind, new(row.GetBoolean(3), nullBehavior == 0, false, (PropertyEmptyPolicy)emptyBehavior),
            TextRange: row.IsDBNull(7) && row.IsDBNull(8) ? null : new(row.IsDBNull(7) ? 0 : row.GetInt32(7), row.IsDBNull(8) ? 16_384 : row.GetInt32(8)),
            NumberRange: row.IsDBNull(9) && row.IsDBNull(10) ? null : new(Number(9), Number(10)),
            DateRange: row.IsDBNull(11) && row.IsDBNull(12) ? null : new(Date(11), Date(12)),
            Options: [], Placement: placement);
        var transition = schema.Apply(new(owner, request, sequence - 1, 0, new PropertyChange.Create(id, key, names, settings)));
        var value = transition.Schema.Find(id)!;
        if (!string.Equals(key, value.MachineKey, StringComparison.Ordinal) || !names.SequenceEqual(value.Names))
            throw new InvalidOperationException("A legacy property label or identity would change during normalization.");
        return new(sequence, id, sourceDigest, transition);

        decimal? Number(int index)
        {
            if (row.IsDBNull(index)) return null;
            var source = row.GetString(index);
            var exact = source.Contains('.') ? source.TrimEnd('0').TrimEnd('.') : source;
            if (exact.Length > 31 || !decimal.TryParse(exact, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture,
                    out var parsed) || parsed.ToString("0.############################", CultureInfo.InvariantCulture) != exact)
                throw new InvalidOperationException("A legacy decimal property bound is not losslessly representable.");
            return parsed;
        }

        DateTimeOffset? Date(int index)
        {
            if (row.IsDBNull(index)) return null;
            var ticks = row.GetInt64(index);
            if (ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks || ticks % TimeSpan.TicksPerMillisecond != 0)
                throw new InvalidOperationException("A legacy date property bound exceeds the V2 wire precision.");
            return new(ticks, TimeSpan.Zero);
        }
    }
}
