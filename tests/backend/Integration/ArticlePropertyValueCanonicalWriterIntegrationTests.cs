using System.Globalization;
using System.Security.Claims;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

// Real canonical owner and PostgreSQL participants; this does not qualify HTTP/session middleware.
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePropertyValueCanonicalWriterIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string AuditKey = "isolated-property-value-canonical-writer-HMAC-key-20261008";
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.Site("primary-site");
    private static readonly string[] s_countTables =
    [
        "article_revision", "article_revision_content_block", "article_rights_snapshot", "article_responsibility_snapshot",
        "article_publication", "article_mutation_outbox", "sys_audit_log", "article_property_value_factset",
        "article_property_value_entry", "article_property_value_option", "article_property_value_reference",
        "article_property_value_snapshot", "article_property_value_head", "article_property_value_receipt"
    ];

    [Fact]
    public async Task PropertyOnlyWrite_PersistsAllEightTypesThroughNewArticleRevisionOutboxAndAuthenticatedRead()
    {
        using Seed data = await SeedAsync();
        Assert.NotNull(data.Context.HttpContext);
        Assert.True(data.Context.HttpContext.User.Identity!.IsAuthenticated);
        Assert.Equal(data.AdminId.ToString(CultureInfo.InvariantCulture), data.Context.HttpContext.User.FindFirst("admin_id")?.Value);
        var definitions = new Dictionary<ArticlePropertyValueType, ArticlePropertyDefinition>();
        foreach (ArticlePropertyValueType type in Enum.GetValues<ArticlePropertyValueType>())
        {
            definitions.Add(type, await DefineAsync(data, type));
        }
        ArticlePropertyValueChange[] changes = definitions.Select(pair => Change(pair.Value, Value(pair.Value))).ToArray();
        WriteState before = await StateAsync(data);
        ArticlePropertyValueMutationReceipt receipt = await data.Writer.MutateAsync(data.AdminId,
            Command(data, before.ArticleRevision, 0, changes));
        ArticlePropertyValueReadModel read = await data.Writer.ReadAsync(data.AdminId, s_owner, data.ArticleId);
        Assert.NotEqual(before.ArticleRevision, read.ArticleRevisionId);
        Assert.Equal(before.ArticleRevision, receipt.ExpectedArticleRevisionId);
        Assert.Equal(1, read.PropertyRevision);
        Assert.Equal(receipt.AfterSnapshotId, read.Current!.SnapshotId);
        Assert.Equal(read.ArticleRevisionId, read.Current.Snapshot.Coordinates.ArticleRevisionId);
        Assert.Null(read.Current.Snapshot.Coordinates.PublicationId);
        Assert.Equal("unchanged body", await BodyAsync(data.Db, data.ArticleId));
        Assert.Equal(before.Counts[0] + 1, await CountAsync(data.Db, "article_revision"));
        Assert.Equal(before.Counts[5] + 1, await CountAsync(data.Db, "article_mutation_outbox"));
        Assert.Equal(before.Counts[6] + 2, await CountAsync(data.Db, "sys_audit_log"));
        Assert.Equal(8, read.Current.Snapshot.Values.Count);
        Assert.All(read.Reconciliation, row => Assert.Equal(ArticlePropertyValueReconciliationStatus.Current, row.Status));
        var values = read.Current.Snapshot.Values.ToDictionary(row => definitions.Single(pair =>
            pair.Value.DefinitionId == row.DefinitionId).Key);
        Assert.Equal(string.Empty, Assert.IsType<ArticlePropertyTextValue>(values[ArticlePropertyValueType.Text].Value).Text);
        Assert.Equal(0m, Assert.IsType<ArticlePropertyNumberValue>(values[ArticlePropertyValueType.Number].Value).Number);
        Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(values[ArticlePropertyValueType.Boolean].Value).Boolean);
        Assert.Equal(TestTemporalContext.CanonicalBusinessEpochUtc.UtcDateTime,
            Assert.IsType<ArticlePropertyDateValue>(values[ArticlePropertyValueType.Date].Value).Utc);
        Assert.Equal(definitions[ArticlePropertyValueType.SingleSelect].Options[0].OptionId,
            Assert.IsType<ArticlePropertySingleSelectValue>(values[ArticlePropertyValueType.SingleSelect].Value).OptionId);
        Assert.Equal(definitions[ArticlePropertyValueType.MultiSelect].Options.Select(option => option.OptionId).Order(),
            Assert.IsType<ArticlePropertyMultiSelectValue>(values[ArticlePropertyValueType.MultiSelect].Value).OptionIds);
        Assert.Empty(Assert.IsType<ArticlePropertyArticleReferenceValue>(values[ArticlePropertyValueType.ArticleReference].Value).ArticleIds);
        Assert.Equal("https://example.com/Case", Assert.IsType<ArticlePropertyUrlValue>(values[ArticlePropertyValueType.Url].Value).Url);
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(read.Current.Snapshot);
        string snapshotAuditId = read.Current.AuditReference.ToString("N");
        string receiptAuditId = receipt.AuditReference.ToString("N");
        List<AuditLog> audit = await data.Db.Queryable<AuditLog>().Where(row =>
            row.TargetId == snapshotAuditId || row.TargetId == receiptAuditId).ToListAsync();
        Assert.Equal(2, audit.Count);
        Assert.All(audit, row => Assert.True(AuditTamperEvidence.Verify(row, Encoding.UTF8.GetBytes(AuditKey))));
        Assert.All(audit, row => Assert.False(AuditTamperEvidence.Verify(row,
            Encoding.UTF8.GetBytes("independent-wrong-property-value-audit-key-20261008"))));
    }

    [Fact]
    public async Task PatchReplaceRemoveAndExactReplay_PreservePresenceAndDoNotDoubleWrite()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition first = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyDefinition second = await DefineAsync(data, ArticlePropertyValueType.Text);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(first, new ArticlePropertyTextValue("one")), Change(second, new ArticlePropertyTextValue("two"))],
            ArticlePropertyValueMutationMode.Replace));
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        var removed = new ArticlePropertyValueChange(ArticlePropertyValueChangeKind.Remove,
            Input(second, ArticlePropertyValuePresence.Missing));
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, read.ArticleRevisionId, read.PropertyRevision,
            [Change(first, new ArticlePropertyTextValue("updated"), ArticlePropertyValueChangeKind.Update), removed]));
        read = await ReadAsync(data);
        Assert.Equal("updated", Text(read, first));
        Assert.Equal(ArticlePropertyValuePresence.Missing, Entry(read, second).Presence);
        ArticlePropertyValueMutationCommand replace = Command(data, read.ArticleRevisionId, read.PropertyRevision,
            [Change(second, new ArticlePropertyTextValue("replacement"))], ArticlePropertyValueMutationMode.Replace);
        ArticlePropertyValueMutationReceipt applied = await data.Writer.MutateAsync(data.AdminId, replace);
        read = await ReadAsync(data);
        Assert.Equal(ArticlePropertyValuePresence.Missing, Entry(read, first).Presence);
        Assert.Equal("replacement", Text(read, second));
        WriteState committed = await StateAsync(data);
        ArticlePropertyValueMutationReceipt replay = await data.Writer.MutateAsync(data.AdminId, replace);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(applied with
        {
            IdempotencyReplay = true
        }, replay);
        await AssertUnchangedAsync(data, committed);
        ArticlePropertyDefinitionConflictException conflict = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(
            () => data.Writer.MutateAsync(data.AdminId, replace with
            {
                Changes = [Change(second, new ArticlePropertyTextValue("different"))]
            }));
        Assert.Equal("article_property_value_idempotency_conflict", conflict.Code);
        await AssertUnchangedAsync(data, committed);
    }

    [Fact]
    public async Task RequiredAndDefaultFields_AreValidatedInsideTransactionAndRetainDefaultProvenance()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition required = await DefineAsync(data, ArticlePropertyValueType.Text, required: true);
        ArticlePropertyDefinition defaulted = await DefineAsync(data, ArticlePropertyValueType.Number,
            defaultValue: new(ArticlePropertyDefaultKind.Scalar, "0"));
        WriteState before = await StateAsync(data);
        ArticlePropertyDefinitionValidationException missing = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => data.Writer.MutateAsync(data.AdminId, Command(data, before.ArticleRevision, 0, [])));
        Assert.Equal("article_property_value_required_or_null_rejected", missing.Code);
        await AssertUnchangedAsync(data, before);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, before.ArticleRevision, 0,
            [Change(required, new ArticlePropertyTextValue("required"))]));
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        Assert.True(Entry(read, defaulted).DefaultApplied);
        Assert.Equal(0m, Assert.IsType<ArticlePropertyNumberValue>(Entry(read, defaulted).Value).Number);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, read.ArticleRevisionId, read.PropertyRevision,
            [Change(required, new ArticlePropertyTextValue("changed"), ArticlePropertyValueChangeKind.Update)]));
        read = await ReadAsync(data);
        Assert.True(Entry(read, defaulted).DefaultApplied);
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(read.Current!.Snapshot);
        WriteState committed = await StateAsync(data);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => data.Writer.MutateAsync(data.AdminId,
            Command(data, read.ArticleRevisionId, read.PropertyRevision,
                [new(ArticlePropertyValueChangeKind.Remove, Input(required, ArticlePropertyValuePresence.Missing))])));
        await AssertUnchangedAsync(data, committed);
    }

    [Fact]
    public async Task PublishThenSaveDraft_PreservesOriginalPublicationSnapshotAndSeparatesNewDraftValues()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(definition, new ArticlePropertyTextValue("published value"))]));
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        ArticlePropertyValuePersistedSnapshot original = read.Current!;
        Assert.True(await data.Service.UpdateAsync(data.ArticleId, Write(data, "unchanged body", ArticleStatus.Published, read.ArticleRevisionId)));
        read = await ReadAsync(data);
        ArticlePropertyValuePersistedSnapshot published = read.Current!;
        Assert.NotEqual(original.SnapshotId, published.SnapshotId);
        Assert.Equal(original.FactsetId, published.FactsetId);
        Assert.Equal(original.Snapshot.Coordinates.PropertyRevision, read.PropertyRevision);
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_factset"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_receipt"));
        Assert.True(published.Snapshot.Coordinates.PublicationId > 0);
        long publicationId = published.Snapshot.Coordinates.PublicationId!.Value;
        long publishedRevision = published.Snapshot.Coordinates.ArticleRevisionId;
        Assert.True(await data.Service.UpdateAsync(data.ArticleId, Write(data, "saved draft body", ArticleStatus.Draft, read.ArticleRevisionId)));
        read = await ReadAsync(data);
        Assert.NotEqual(publishedRevision, read.ArticleRevisionId);
        Assert.NotEqual(published.SnapshotId, read.Current!.SnapshotId);
        Assert.Equal(published.FactsetId, read.Current.FactsetId);
        Assert.Equal(published.Snapshot.Coordinates.PropertyRevision, read.PropertyRevision);
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_factset"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_receipt"));
        Assert.Null(read.Current!.Snapshot.Coordinates.PublicationId);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, read.ArticleRevisionId, read.PropertyRevision,
            [Change(definition, new ArticlePropertyTextValue("draft only"), ArticlePropertyValueChangeKind.Update)]));
        ArticlePropertyValuePersistedSnapshot historical = (await data.Persistence.ReadSnapshotAsync(s_owner,
            data.ArticleId, published.SnapshotId))!;
        Assert.Equal(published.Snapshot.ContentDigest, historical.Snapshot.ContentDigest);
        Assert.Equal(published.AuditRecordHash, historical.AuditRecordHash);
        Assert.Equal(published.FactsetId, historical.FactsetId);
        Assert.Equal(publicationId, historical.Snapshot.Coordinates.PublicationId);
        Assert.Equal("published value", Assert.IsType<ArticlePropertyTextValue>(Assert.Single(historical.Snapshot.Values).Value).Text);
        Assert.Equal(publishedRevision, Convert.ToInt64(await data.Db.Ado.GetScalarAsync(
            "SELECT article_revision_id FROM article_publication WHERE id = @Id", new SugarParameter("@Id", publicationId)), CultureInfo.InvariantCulture));
        read = await ReadAsync(data);
        Assert.Equal("draft only", Text(read, definition));
        Assert.NotEqual(published.FactsetId, read.Current!.FactsetId);
        Assert.Equal(published.Snapshot.Coordinates.PropertyRevision + 1, read.PropertyRevision);
        Assert.Equal(2, await CountAsync(data.Db, "article_property_value_factset"));
        Assert.Equal(2, await CountAsync(data.Db, "article_property_value_receipt"));
        Assert.Null(read.Current!.Snapshot.Coordinates.PublicationId);
        ArticlePropertyValuePersistedSnapshot originalAfter = (await data.Persistence.ReadSnapshotAsync(s_owner,
            data.ArticleId, original.SnapshotId))!;
        Assert.Equal(original.Snapshot.ContentDigest, originalAfter.Snapshot.ContentDigest);
        Assert.Equal(original.AuditRecordHash, originalAfter.AuditRecordHash);
        Assert.Equal(original.Snapshot.Coordinates, originalAfter.Snapshot.Coordinates);
    }

    [Fact]
    public async Task DeletedDefinition_RemainsAnAuthenticatedTombstoneForStoredValues()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(definition, new ArticlePropertyTextValue("historical value"))]));
        ArticlePropertyValueReadModel before = await ReadAsync(data);
        WriteState stored = await StateAsync(data);
        ArticlePropertyDefinitionWriteReceipt deprecated = await data.Definitions.DeprecateAsync(new(data.Actor,
            s_owner, definition.DefinitionId, Guid.CreateVersion7(), data.OwnerRevision, definition.SchemaRevision));
        ArticlePropertyDefinitionWriteReceipt deleted = await data.Definitions.DeleteAsync(new(data.Actor,
            s_owner, definition.DefinitionId, Guid.CreateVersion7(), deprecated.OwnerRevision, deprecated.SchemaRevision));
        Assert.Equal(ArticlePropertyDefinitionStatus.Deleted, deleted.Status);
        Assert.NotEmpty(deleted.Obligations);
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        Assert.Equal(ArticlePropertyDefinitionStatus.Deleted,
            Assert.Single(read.Definitions, row => row.DefinitionId == definition.DefinitionId).Status);
        ArticlePropertyValueReconciliation reconciliation = Assert.Single(read.Reconciliation,
            row => row.DefinitionId == definition.DefinitionId);
        Assert.Equal(ArticlePropertyValueReconciliationStatus.DefinitionInactive, reconciliation.Status);
        Assert.Equal("article_property_definition_inactive", reconciliation.ReasonCode);
        Assert.Equal(before.Current!.SnapshotId, read.Current!.SnapshotId);
        Assert.Equal(before.Current.Snapshot.ContentDigest, read.Current.Snapshot.ContentDigest);
        Assert.Equal(before.Current.AuditRecordHash, read.Current.AuditRecordHash);
        Assert.Equal("historical value", Text(read, definition));
        WriteState after = await StateAsync(data);
        Assert.Equal(stored.ArticleRevision, after.ArticleRevision);
        Assert.Equal(stored.Body, after.Body);
        Assert.Equal(stored.Counts.Where((_, index) => index != 6), after.Counts.Where((_, index) => index != 6));
    }

    [Fact]
    public async Task CanonicalRollbackWithIncompleteHistoricalPackage_RejectsWithoutChangingPropertyHistory()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(definition, new ArticlePropertyTextValue("original facts"))]));
        ArticlePropertyValueReadModel original = await ReadAsync(data);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, original.ArticleRevisionId, original.PropertyRevision,
            [Change(definition, new ArticlePropertyTextValue("current facts"), ArticlePropertyValueChangeKind.Update)]));
        ArticlePropertyValueReadModel current = await ReadAsync(data);
        Assert.Equal(1, Convert.ToInt64(await data.Db.Ado.GetScalarAsync(
            "SELECT count(*) FROM article_rights_snapshot WHERE article_revision_id = @Id",
            new SugarParameter("@Id", original.ArticleRevisionId)), CultureInfo.InvariantCulture));
        Assert.Equal(0, Convert.ToInt64(await data.Db.Ado.GetScalarAsync(
            "SELECT count(*) FROM article_responsibility_snapshot WHERE article_revision_id = @Id",
            new SugarParameter("@Id", original.ArticleRevisionId)), CultureInfo.InvariantCulture));
        WriteState before = await StateAsync(data);
        var command = new UpdateArticleCommand(data.ArticleId,
            Write(data, "unchanged body", ArticleStatus.Draft, current.ArticleRevisionId), ArticleUpdateIntent.Rollback,
            Rollback: new(original.ArticleRevisionId, data.AdminId, "isolated incomplete package rollback"));
        ArticleWriteValidationException error = await Assert.ThrowsAsync<ArticleWriteValidationException>(
            () => ((IArticleCoreGateway)data.Service).UpdateAsync(command, CancellationToken.None));
        Assert.Equal("article_revision_package_incomplete", error.Code);
        await AssertUnchangedAsync(data, before);
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        Assert.Equal(current.Current!.Snapshot.ContentDigest, read.Current!.Snapshot.ContentDigest);
        Assert.Equal(current.Current.SnapshotId, read.Current.SnapshotId);
        Assert.Equal("current facts", Text(read, definition));
        ArticlePropertyValuePersistedSnapshot historical = (await data.Persistence.ReadSnapshotAsync(s_owner,
            data.ArticleId, original.Current!.SnapshotId))!;
        Assert.Equal(original.Current.Snapshot.ContentDigest, historical.Snapshot.ContentDigest);
        Assert.Equal(original.Current.AuditRecordHash, historical.AuditRecordHash);
        Assert.Equal("original facts", Assert.IsType<ArticlePropertyTextValue>(Assert.Single(historical.Snapshot.Values).Value).Text);
    }

    [Fact]
    public async Task TwoIndependentDevices_AllowExactlyOneAtomicCasWrite()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        using SqlSugarClient otherDb = PostgresSqlSugarTestClient.Create(data.Db.CurrentConnectionConfig.ConnectionString);
        Composition other = Compose(otherDb, data.AdminId, "second-device");
        WriteState before = await StateAsync(data);
        ArticlePropertyValueMutationCommand first = Command(data, before.ArticleRevision, 0, [Change(definition, new ArticlePropertyTextValue("first"))]);
        ArticlePropertyValueMutationCommand second = Command(data, before.ArticleRevision, 0, [Change(definition, new ArticlePropertyTextValue("second"))]);
        (ArticlePropertyValueMutationReceipt? Receipt, Exception? Error)[] results = await Task.WhenAll(
            Task.Run(() => AttemptAsync(data.Writer, data.AdminId, first)),
            Task.Run(() => AttemptAsync((IArticlePropertyValueAuthority)other.Service, data.AdminId, second)));
        Assert.Single(results, result => result.Receipt is not null);
        Assert.IsType<ArticleRevisionConflictException>(Assert.Single(results, result => result.Error is not null).Error);
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        Assert.Equal(1, read.PropertyRevision);
        Assert.Equal(before.Counts[0] + 1, await CountAsync(data.Db, "article_revision"));
        Assert.Equal(before.Counts[5] + 1, await CountAsync(data.Db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_receipt"));
        Assert.Contains(Text(read, definition), new[] { "first", "second" });
    }

    [Theory]
    [InlineData("article-revision")]
    [InlineData("property-revision")]
    [InlineData("definition-revision")]
    [InlineData("wrong-type")]
    [InlineData("nonempty-reference")]
    public async Task InvalidCoordinatesAndFields_LeaveAllCanonicalAndPropertyWritesUnchanged(string failure)
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data,
            failure == "nonempty-reference" ? ArticlePropertyValueType.ArticleReference : ArticlePropertyValueType.Text);
        ArticlePropertyValueInput input = Input(definition, ArticlePropertyValuePresence.Present,
            failure switch
            {
                "wrong-type" => new ArticlePropertyNumberValue(2m),
                "nonempty-reference" => new ArticlePropertyArticleReferenceValue([data.ArticleId + 1L]),
                _ => new ArticlePropertyTextValue("valid")
            });
        if (failure == "definition-revision")
        {
            input = input with
            {
                DefinitionSchemaRevision = input.DefinitionSchemaRevision + 1
            };
        }
        WriteState before = await StateAsync(data);
        ArticlePropertyValueMutationCommand command = Command(data, before.ArticleRevision, 0, [new(ArticlePropertyValueChangeKind.Create, input)]);
        if (failure == "article-revision")
            command = command with
            {
                ExpectedArticleRevisionId = before.ArticleRevision + 1
            };
        if (failure == "property-revision")
            command = command with
            {
                ExpectedPropertyRevision = 1
            };
        if (failure == "article-revision")
            await Assert.ThrowsAsync<ArticleRevisionConflictException>(() => data.Writer.MutateAsync(data.AdminId, command));
        else if (failure == "property-revision")
            await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => data.Writer.MutateAsync(data.AdminId, command));
        else
        {
            ArticlePropertyDefinitionValidationException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
                () => data.Writer.MutateAsync(data.AdminId, command));
            if (failure == "nonempty-reference")
                Assert.Equal("article_property_reference_authority_unavailable", error.Code);
        }
        await AssertUnchangedAsync(data, before);
    }

    [Theory]
    [InlineData("article_property_value_snapshot")]
    [InlineData("article_property_value_receipt")]
    public async Task ActualInjectedPersistenceFailure_RollsBackArticleOutboxPropertyHeadAndSignedAudit(string table)
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        WriteState before = await StateAsync(data);
        Assert.Contains(table, new[] { "article_property_value_snapshot", "article_property_value_receipt" });
        await data.Db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION reject_property_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'isolated property value persistence failure'; END $$;
            """ + $"CREATE TRIGGER reject_property BEFORE INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION reject_property_write();");
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => data.Writer.MutateAsync(data.AdminId,
            Command(data, before.ArticleRevision, 0, [Change(definition, new ArticlePropertyTextValue("rejected"))])));
        Assert.Contains("isolated property value persistence failure", error.ToString(), StringComparison.Ordinal);
        await AssertUnchangedAsync(data, before);
    }

    [Fact]
    public async Task StoredSnapshotRequiresActualAuditMac_AndRejectsForgedMac()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(definition, new ArticlePropertyTextValue("authenticated"))]));
        ArticlePropertyValueReadModel read = await ReadAsync(data);
        Guid snapshot = read.Current!.SnapshotId;
        Assert.Equal(1, await data.Db.Ado.ExecuteCommandAsync("UPDATE sys_audit_log SET record_mac = @Mac WHERE target_type = 'article-property-value-snapshot' AND target_id = @Id;",
            new SugarParameter("@Mac", new string('0', 64)), new SugarParameter("@Id", snapshot.ToString("N"))));
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() => ReadAsync(data));
        Assert.Equal("article_property_value_authenticated_audit_invalid", error.Code);
    }

    [Fact]
    public async Task MissingAuditKey_RefusesAndRollsBackCanonicalArticleWrites()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        Composition missingKey = Compose(data.Db, data.AdminId, "missing-key-device", auditKey: null);
        WriteState before = await StateAsync(data);
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => ((IArticlePropertyValueAuthority)missingKey.Service).MutateAsync(data.AdminId,
                Command(data, before.ArticleRevision, 0, [Change(definition, new ArticlePropertyTextValue("unsigned"))])));
        Assert.Equal("article_property_value_audit_key_missing", error.Code);
        await AssertUnchangedAsync(data, before);
    }

    private async Task<Seed> SeedAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleBody), typeof(ArticleTag), typeof(Category), typeof(Tag),
            typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticleRightsProof),
            typeof(ArticlePublicationRecord), typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(AdminPrincipal), typeof(AuditLog));
        foreach (var migration in new[] { ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration(), ArticlePropertyValueMigrationDefinitions.BuildMigration() })
            foreach (var step in migration.Steps)
                await step.ExecuteAsync(db, CancellationToken.None);
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "isolated-property-writer",
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = string.Join('\n', AdminPermissions.All)
        }).ExecuteReturnBigIdentityAsync();
        int category = await db.Insertable(new Category { Name = "isolated-property-category" }).ExecuteReturnIdentityAsync();
        Composition composition = Compose(db, admin, "first-device");
        Assert.NotNull(composition.Context.HttpContext);
        Assert.Equal(admin.ToString(CultureInfo.InvariantCulture), composition.Context.HttpContext.User.FindFirst("admin_id")?.Value);
        int article = await composition.Service.CreateAsync(new ArticleWriteRequestCoreModel("property source", "unchanged body", "summary",
            null, category, [], (int)ArticleStatus.Draft));
        return new(db, composition, admin, article, category);
    }

    private static Composition Compose(SqlSugarClient db, long admin, string device, string? auditKey = AuditKey)
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = auditKey
        }).Build();
        TimeProvider clock = TestTemporalContext.FromEnvironment().BusinessClock;
        var permissions = new ArticlePropertyDefinitionPermissionAuthority();
        var store = new ArticlePropertyDefinitionStore(new PostgresArticlePropertyDefinitionPersistence(db, configuration), permissions,
            new PostgresArticlePropertyDefinitionValueImpactAuthority(db), new ArticlePropertyDefinitionVerifier(configuration), clock);
        var persistence = new ArticlePropertyValuePersistence(db, configuration, clock);
        var validator = new ArticlePropertyValueValidator(store, permissions, new UnavailableArticlePropertyReferenceValueAuthority());
        var context = Substitute.For<IHttpContextAccessor>();
        context.HttpContext.Returns(new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("admin_id", admin.ToString(CultureInfo.InvariantCulture)), new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
             new Claim("admin_sid", device)], "fixture"))
        });
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var service = new ArticleService(_db: db, _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis), _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(), _stringReader: Substitute.For<ICacheStringReader>(), _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(), _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope, _httpContextAccessor: context, _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(), _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(), _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(), _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(), _timeProvider: clock,
            _articlePropertyValues: persistence, _articlePropertyValueValidator: validator, _articlePropertyDefinitions: store);
        return new(service, store, persistence, context);
    }

    private static async Task<ArticlePropertyDefinition> DefineAsync(Seed data, ArticlePropertyValueType type,
        bool required = false, ArticlePropertyDefaultValue? defaultValue = null)
    {
        Guid id = Guid.CreateVersion7();
        ArticlePropertyCardinality cardinality = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference
            ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        ArticlePropertyOption[] options = type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
            ? [new(Guid.CreateVersion7(), "first", 0, ArticlePropertyOptionStatus.Active), new(Guid.CreateVersion7(), "second", 1, ArticlePropertyOptionStatus.Active)] : [];
        ArticlePropertyDefinitionWriteReceipt receipt = await data.Definitions.CreateAsync(new(data.Actor, s_owner, id,
            Guid.CreateVersion7(), data.OwnerRevision, "field-" + id.ToString("N"), [new("en", "Isolated typed field")], type, cardinality, required,
            new(defaultValue is null ? ArticlePropertyMissingBehavior.PreserveMissing : ArticlePropertyMissingBehavior.ApplyDefault,
                required ? ArticlePropertyNullBehavior.RejectNull : ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), defaultValue, new(), options,
            type == ArticlePropertyValueType.ArticleReference ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget,
                false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2048, ArticlePropertyUrlNormalization.PreservePathCase) : null,
            false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.SiteEditors));
        data.OwnerRevision = receipt.OwnerRevision;
        return (await data.Definitions.GetAsync(data.Actor, s_owner, id))!;
    }

    private static ArticlePropertyTypedValue Value(ArticlePropertyDefinition definition) => definition.ValueType switch
    {
        ArticlePropertyValueType.Text => new ArticlePropertyTextValue(string.Empty),
        ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0m),
        ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
        ArticlePropertyValueType.Date => new ArticlePropertyDateValue(TestTemporalContext.CanonicalBusinessEpochUtc.UtcDateTime),
        ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(definition.Options[0].OptionId),
        ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue(definition.Options.Select(option => option.OptionId).OrderDescending()),
        ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([]),
        ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/Case"),
        _ => throw new InvalidOperationException("unsupported test type")
    };

    private static ArticlePropertyValueInput Input(ArticlePropertyDefinition definition, ArticlePropertyValuePresence presence,
        ArticlePropertyTypedValue? value = null) => new(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest, presence, value);
    private static ArticlePropertyValueChange Change(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value,
        ArticlePropertyValueChangeKind kind = ArticlePropertyValueChangeKind.Create) => new(kind, Input(definition, ArticlePropertyValuePresence.Present, value));
    private static ArticlePropertyValueMutationCommand Command(Seed data, long revision, long propertyRevision,
        IReadOnlyList<ArticlePropertyValueChange> changes, ArticlePropertyValueMutationMode mode = ArticlePropertyValueMutationMode.Patch)
        => new(Guid.CreateVersion7(), null, s_owner.SiteScope, data.ArticleId, revision, propertyRevision, mode, changes);
    private static ArticlePropertyValueEntry Entry(ArticlePropertyValueReadModel read, ArticlePropertyDefinition definition)
        => Assert.Single(read.Current!.Snapshot.Values, row => row.DefinitionId == definition.DefinitionId);
    private static string Text(ArticlePropertyValueReadModel read, ArticlePropertyDefinition definition)
        => Assert.IsType<ArticlePropertyTextValue>(Entry(read, definition).Value).Text;
    private static Task<ArticlePropertyValueReadModel> ReadAsync(Seed data) => data.Writer.ReadAsync(data.AdminId, s_owner, data.ArticleId);
    private static ArticleWriteRequestCoreModel Write(Seed data, string body, ArticleStatus status, long revision)
        => new("property source", body, "summary", null, data.CategoryId, [], (int)status, BaseRevisionId: revision);
    private static async Task<long> CountAsync(SqlSugarClient db, string table)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT count(*) FROM " + table), CultureInfo.InvariantCulture);
    private static async Task<long> RevisionAsync(SqlSugarClient db, int article)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT current_revision_id FROM article WHERE id = @Id", new SugarParameter("@Id", article)), CultureInfo.InvariantCulture);
    private static Task<string> BodyAsync(SqlSugarClient db, int article)
        => db.Ado.GetStringAsync("SELECT markdown_content FROM article_body WHERE article_id = @Id", new SugarParameter("@Id", article));
    private static async Task<WriteState> StateAsync(Seed data)
    {
        var counts = new List<long>();
        foreach (string table in s_countTables)
            counts.Add(await CountAsync(data.Db, table));
        return new(await RevisionAsync(data.Db, data.ArticleId), await BodyAsync(data.Db, data.ArticleId), counts.ToArray());
    }
    private static async Task AssertUnchangedAsync(Seed data, WriteState before)
    {
        WriteState after = await StateAsync(data);
        Assert.Equal(before.ArticleRevision, after.ArticleRevision);
        Assert.Equal(before.Body, after.Body);
        Assert.Equal(before.Counts, after.Counts);
    }
    private static async Task<(ArticlePropertyValueMutationReceipt? Receipt, Exception? Error)> AttemptAsync(
        IArticlePropertyValueAuthority writer, long actor, ArticlePropertyValueMutationCommand command)
    {
        try
        {
            return (await writer.MutateAsync(actor, command), null);
        }
        catch (Exception error)
        {
            return (null, error);
        }
    }
    private sealed record WriteState(long ArticleRevision, string Body, long[] Counts);
    private sealed record Composition(ArticleService Service, ArticlePropertyDefinitionStore Store,
        ArticlePropertyValuePersistence Persistence, IHttpContextAccessor Context);
    private sealed class Seed(SqlSugarClient db, Composition composition, long admin, int article, int category) : IDisposable
    {
        public SqlSugarClient Db => db;
        public ArticleService Service => composition.Service;
        public IArticlePropertyValueAuthority Writer => composition.Service;
        public ArticlePropertyDefinitionStore Definitions => composition.Store;
        public ArticlePropertyValuePersistence Persistence => composition.Persistence;
        public IHttpContextAccessor Context => composition.Context;
        public long AdminId => admin;
        public int ArticleId => article;
        public int CategoryId => category;
        public ArticlePropertyDefinitionActor Actor => new(admin, AdminPermissions.All);
        public long OwnerRevision
        {
            get; set;
        }
        public void Dispose() => db.Dispose();
    }
}
