using System.Globalization;
using System.Text;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

// Synthetic PostgreSQL acceptance of the participant, not admission of the unreviewed
// template dependency or activation of a production create receiver.
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePropertyValueInitialCreateIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string AuditKey = "isolated-initial-create-property-HMAC-key-20261018";
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.Site("primary-site");
    private static readonly string[] s_tables =
    [
        "article", "article_body", "article_draft", "article_revision", "article_revision_content_block",
        "article_rights_policy", "article_mutation_outbox", "article_create_request", "article_create_receipt",
        "article_property_value_factset", "article_property_value_entry", "article_property_value_option",
        "article_property_value_reference", "article_property_value_snapshot", "article_property_value_head",
        "article_property_value_receipt", "sys_audit_log"
    ];

    [Fact]
    public async Task RealCreate_AllEightTypesUseActualInitialRevisionAndOneCallerTransaction()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyValuePersistedSnapshot? written = null;
        NpgsqlTransaction? heldTransaction = null;
        Func<int> calls = InstallParticipant(data, data.Db, data.Command, (db, transaction, article, revision) =>
        {
            heldTransaction = transaction;
            written = data.Properties.SaveInitialCreateAsync(transaction, data.Command, data.Actor, s_owner,
                article, revision).GetAwaiter().GetResult();
        });
        Assert.Equal(0, calls());
        ArticleCreateReceipt receipt = await ExecuteAsync(data, data.Db, data.Command);
        Assert.Equal(1, calls());
        Assert.NotNull(heldTransaction);
        Assert.Null(data.Db.Ado.Transaction);
        Assert.NotNull(written);
        Assert.Equal(receipt.ArticleId, written.Snapshot.Coordinates.ArticleId);
        Assert.Equal(receipt.RevisionId, written.Snapshot.Coordinates.ArticleRevisionId);
        Assert.Equal(1, written.Snapshot.Coordinates.PropertyRevision);
        Assert.Null(written.Snapshot.Coordinates.DraftId);
        Assert.Null(written.Snapshot.Coordinates.DraftServerRevision);
        Assert.Null(written.Snapshot.Coordinates.PublicationId);
        Assert.Equal(8, written.Snapshot.Values.Count);
        Assert.True(await ReceiptMatchesWrittenAggregateAsync(data, receipt, data.Command));
        Assert.Equal(1, await CountAsync(data.Db, "article"));
        Assert.Equal(1, await CountAsync(data.Db, "article_revision"));
        Assert.Equal(1, await CountAsync(data.Db, "article_draft"));
        Assert.Equal(1, await CountAsync(data.Db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_factset"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_snapshot"));
        Assert.Equal(0, await CountAsync(data.Db, "article_property_value_receipt"));
        Assert.Equal(1, await data.Db.Ado.GetIntAsync(
            "SELECT count(*) FROM sys_audit_log WHERE action = 'article-property-values-snapshot';"));
    }

    [Theory]
    [InlineData("factset")]
    [InlineData("entry")]
    [InlineData("snapshot")]
    [InlineData("head")]
    [InlineData("after-participant")]
    [InlineData("create-receipt")]
    public async Task FailureAtRealWriteStage_RollsBackWholeCreateAndSameRequestCanRetry(string stage)
    {
        using Seed data = await SeedAsync();
        long[] before = await CountsAsync(data.Db);
        InstallParticipant(data, data.Db, data.Command, after: stage == "after-participant"
            ? () => throw new IOException("isolated participant failure") : null, failureStage: stage);
        await Assert.ThrowsAsync<IOException>(() => ExecuteAsync(data, data.Db, data.Command));
        Assert.Equal(before, await CountsAsync(data.Db));
        InstallParticipant(data, data.Db, data.Command);
        ArticleCreateReceipt retry = await ExecuteAsync(data, data.Db, data.Command);
        Assert.True(await ReceiptMatchesWrittenAggregateAsync(data, retry, data.Command));
        ArticleCreateReceipt replay = await ExecuteAsync(data, data.Db, data.Command);
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(retry.ReceiptId, replay.ReceiptId);
        Assert.Equal(1, await CountAsync(data.Db, "article"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_snapshot"));
    }

    [Fact]
    public async Task AbsentHeadCas_DuplicateParticipantIsConflictAndRollsBackCanonicalCreate()
    {
        using Seed data = await SeedAsync();
        long[] before = await CountsAsync(data.Db);
        InstallParticipant(data, data.Db, data.Command, (db, transaction, article, revision) =>
        {
            _ = data.Properties.SaveInitialCreateAsync(transaction, data.Command, data.Actor, s_owner,
                article, revision).GetAwaiter().GetResult();
            _ = data.Properties.SaveInitialCreateAsync(transaction, data.Command, data.Actor, s_owner,
                article, revision).GetAwaiter().GetResult();
        });
        var error = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(
            () => ExecuteAsync(data, data.Db, data.Command));
        Assert.Equal("article_property_value_revision_conflict", error.Code);
        Assert.Equal(before, await CountsAsync(data.Db));
    }

    [Fact]
    public async Task ConcurrentCanonicalRetries_CommitOneAggregateAndReplayOneReceipt()
    {
        using Seed data = await SeedAsync();
        using SqlSugarClient second = PostgresSqlSugarTestClient.Create(data.Db.CurrentConnectionConfig.ConnectionString);
        InstallParticipant(data, data.Db, data.Command);
        InstallParticipant(data, second, data.Command);
        ArticleCreateReceipt[] receipts = await Task.WhenAll(
            ExecuteAsync(data, data.Db, data.Command), ExecuteAsync(data, second, data.Command));
        Assert.Equal(receipts[0].ReceiptId, receipts[1].ReceiptId);
        Assert.Equal(receipts[0].ArticleId, receipts[1].ArticleId);
        Assert.Single(receipts.Where(static receipt => !receipt.IsIdempotentReplay));
        Assert.Equal(1, await CountAsync(data.Db, "article_revision"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_factset"));
        Assert.Equal(1, await CountAsync(data.Db, "article_property_value_snapshot"));
        Assert.Equal(1, await CountAsync(data.Db, "article_create_receipt"));
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("permission")]
    [InlineData("owner")]
    [InlineData("revision")]
    [InlineData("transaction")]
    [InlineData("cancel")]
    public async Task CurrentContextOrActualCoordinatesCannotBeBorrowed(string mutation)
    {
        using Seed data = await SeedAsync();
        using SqlSugarClient foreign = PostgresSqlSugarTestClient.Create(data.Db.CurrentConnectionConfig.ConnectionString);
        foreign.Ado.BeginTran();
        long[] before = await CountsAsync(data.Db);
        InstallParticipant(data, data.Db, data.Command, (db, transaction, article, revision) =>
        {
            using var cancellation = new CancellationTokenSource();
            if (mutation == "cancel")
            {
                cancellation.Cancel();
            }
            _ = data.Properties.SaveInitialCreateAsync(
                mutation == "transaction" ? (NpgsqlTransaction)foreign.Ado.Transaction : transaction,
                data.Command,
                mutation == "actor" ? new ArticleTemplateActor(data.Actor.AdminPrincipalId + 1, data.Actor.Permissions)
                    : mutation == "permission" ? new ArticleTemplateActor(data.Actor.AdminPrincipalId, []) : data.Actor,
                mutation == "owner" ? ArticlePropertyDefinitionOwner.Site("foreign-site") : s_owner,
                article, mutation == "revision" ? revision + 1 : revision, cancellation.Token).GetAwaiter().GetResult();
        });
        try
        {
            Exception? error = await Record.ExceptionAsync(() => ExecuteAsync(data, data.Db, data.Command));
            Assert.NotNull(error);
            Assert.True(error is ArticlePropertyDefinitionIntegrityException or OperationCanceledException, error.ToString());
            Assert.Equal(before, await CountsAsync(data.Db));
        }
        finally
        {
            foreign.Ado.RollbackTran();
        }
    }

    [Fact]
    public async Task CommittedCreateCannotBePatchedInSecondTransaction()
    {
        using Seed data = await SeedAsync();
        // Original production store still refuses the property defaults without a receiver.
        var store = new ArticleCreateStore(new PostgresArticleCreatePersistence(data.Db, data.Configuration), data.Verifier);
        var refusal = await Assert.ThrowsAsync<ArticleCreateValidationException>(() => store.CreateAsync(data.Command));
        Assert.Equal("article_create_defaults_receiver_unavailable", refusal.Code);
        Assert.Equal(0, await CountAsync(data.Db, "article"));

        ArticleCreateReceipt receipt = await ExecuteAsync(data, data.Db, data.Command);
        Assert.False(await ReceiptMatchesWrittenAggregateAsync(data, receipt, data.Command));
        data.Db.Ado.BeginTran();
        try
        {
            var error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
                () => data.Properties.SaveInitialCreateAsync((NpgsqlTransaction)data.Db.Ado.Transaction,
                    data.Command, data.Actor, s_owner, receipt.ArticleId, receipt.RevisionId));
            Assert.Equal("article_property_value_initial_create_coordinates_invalid", error.Code);
        }
        finally
        {
            data.Db.Ado.RollbackTran();
        }
        Assert.Equal(1, await CountAsync(data.Db, "article_revision"));
        Assert.Equal(0, await CountAsync(data.Db, "article_property_value_factset"));
    }

    [Theory]
    [InlineData("defaults-replaced")]
    [InlineData("defaults-value-replaced")]
    [InlineData("pinless-resealed")]
    [InlineData("typed-value-resealed")]
    [InlineData("source-replaced")]
    public async Task DefaultsPinsAndSealMismatch_CannotAuthorizeParticipant(string mutation)
    {
        using Seed data = await SeedAsync();
        ArticleTemplateExpansionPlan changed = ChangePlan(data.Plan, mutation);
        var command = new ArticleCreateCommand(data.Actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            changed.Input.TemplateId, changed.VersionId, changed, changed.ContentDigest);
        long[] before = await CountsAsync(data.Db);
        InstallParticipant(data, data.Db, command);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() => ExecuteAsync(data, data.Db, command));
        Assert.Equal(before, await CountsAsync(data.Db));
    }

    [Fact]
    public async Task DefinitionDriftAfterPlanning_IsRejectedInsideActualCreateTransaction()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = data.Definitions[0];
        _ = await data.DefinitionStore.RenameAsync(new(new(data.Actor.AdminPrincipalId, data.Actor.Permissions), s_owner,
            definition.DefinitionId, Guid.CreateVersion7(), data.Definitions.Count, definition.SchemaRevision,
            [new("en", "Changed after planning")]));
        long[] before = await CountsAsync(data.Db);
        InstallParticipant(data, data.Db, data.Command);
        var error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => ExecuteAsync(data, data.Db, data.Command));
        Assert.Equal("article_property_value_initial_create_plan_stale", error.Code);
        Assert.Equal(before, await CountsAsync(data.Db));
    }

    [Theory]
    [InlineData("receipt-article")]
    [InlineData("receipt-revision")]
    [InlineData("receipt-plan")]
    [InlineData("missing-head")]
    [InlineData("entry-tamper")]
    [InlineData("snapshot-audit-tamper")]
    public async Task ActualReceiptToWrittenAggregate_RejectsCoordinateFactAndMacTamper(string mutation)
    {
        using Seed data = await SeedAsync();
        InstallParticipant(data, data.Db, data.Command);
        ArticleCreateReceipt receipt = await ExecuteAsync(data, data.Db, data.Command);
        Assert.True(await ReceiptMatchesWrittenAggregateAsync(data, receipt, data.Command));
        ArticleCreateReceipt changed = mutation switch
        {
            "receipt-article" => receipt with { ArticleId = receipt.ArticleId + 1 },
            "receipt-revision" => receipt with { RevisionId = receipt.RevisionId + 1 },
            "receipt-plan" => receipt with { PlanDigest = new string('0', 64) },
            _ => receipt
        };
        data.Db.Aop.OnLogExecuting = null;
        if (mutation == "missing-head")
        {
            await data.Db.Ado.ExecuteCommandAsync("DELETE FROM article_property_value_head;");
        }
        else if (mutation == "entry-tamper")
        {
            await data.Db.Ado.ExecuteCommandAsync(
                "UPDATE article_property_value_entry SET boolean_value = true WHERE value_type = 2;");
        }
        else if (mutation == "snapshot-audit-tamper")
        {
            await data.Db.Ado.ExecuteCommandAsync(
                "UPDATE article_property_value_snapshot SET audit_record_hash = @Hash;",
                new SugarParameter("@Hash", new string('0', 64)));
        }
        Assert.False(await ReceiptMatchesWrittenAggregateAsync(data, changed, data.Command));
    }

    [Theory]
    [InlineData("rights")]
    [InlineData("responsibility")]
    [InlineData("prepublish")]
    public async Task MissingProfileAuthoritiesStillRefuse(string profile)
    {
        using Seed data = await SeedAsync();
        var reference = new ArticleTemplateProfileReference(Guid.CreateVersion7(), 1);
        var defaults = new ArticleTemplateDefaults(
            propertyDefaults: data.Plan.Defaults.PropertyDefaults,
            rightsProfile: profile == "rights" ? reference : null,
            responsibilityProfile: profile == "responsibility" ? reference : null,
            prepublishProfile: profile == "prepublish" ? reference : null);
        long[] before = await CountsAsync(data.Db);
        await Assert.ThrowsAsync<ArticleTemplateReferenceException>(
            () => data.References.ValidateAndPinAsync(data.Actor, data.Plan.Scope, defaults));
        Assert.Equal(before, await CountsAsync(data.Db));
    }

    private async Task<Seed> SeedAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Category), typeof(Tag), typeof(ContentAsset),
            typeof(ContentAssetReference), typeof(AdminPrincipal), typeof(AuditLog), typeof(Article), typeof(ArticleBody),
            typeof(ArticleTag), typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ArticleDraft),
            typeof(ArticleRightsPolicy), typeof(ArticleRightsSnapshot), typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent));
        foreach (ISchemaMigrationDescriptor migration in new[]
        {
            ArticleTemplateAuthorityMigrationDefinitions.BuildMigration(), ArticleCreateAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration(), ArticlePropertyValueMigrationDefinitions.BuildMigration()
        })
        {
            foreach (SchemaMigrationStep step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = AuditKey
        }).Build();
        TimeProvider clock = TestTemporalContext.FromEnvironment().BusinessClock;
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "isolated-initial-property",
            DisplayName = "Synthetic Author",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.All),
            IsRoot = true
        }).ExecuteReturnBigIdentityAsync();
        var actor = new ArticleTemplateActor(admin, AdminPermissions.All);
        var propertyActor = new ArticlePropertyDefinitionActor(admin, actor.Permissions);
        var permissions = new ArticlePropertyDefinitionPermissionAuthority();
        var definitions = new ArticlePropertyDefinitionStore(new PostgresArticlePropertyDefinitionPersistence(db, configuration),
            permissions, new PostgresArticlePropertyDefinitionValueImpactAuthority(db),
            new ArticlePropertyDefinitionVerifier(configuration), clock);
        var validator = new ArticlePropertyValueValidator(definitions, permissions, new UnavailableArticlePropertyReferenceValueAuthority());
        var references = new PostgresArticleTemplateReferenceAuthority(db, definitions, validator, s_owner);
        var templatePersistence = new PostgresArticleTemplatePersistence(db, configuration);
        var planner = new ArticleTemplateExpansionPlanner(templatePersistence, new ArticleTemplatePermissionAuthority(),
            references, new PostgresArticleTemplateExpansionAuthority(db), clock);
        var verifier = new ArticleTemplateExpansionVerifier(planner, clock);
        var all = new List<ArticlePropertyDefinition>();
        foreach (ArticlePropertyValueType type in Enum.GetValues<ArticlePropertyValueType>())
        {
            Guid id = Guid.CreateVersion7();
            ArticlePropertyCardinality cardinality = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference
                ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
            ArticlePropertyOption[] options = type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(Guid.CreateVersion7(), "first", 0, ArticlePropertyOptionStatus.Active),
                    new(Guid.CreateVersion7(), "second", 1, ArticlePropertyOptionStatus.Active)] : [];
            _ = await definitions.CreateAsync(new(propertyActor, s_owner, id, Guid.CreateVersion7(), all.Count,
                "field-" + id.ToString("N"), [new("en", "Synthetic typed field")], type, cardinality, false,
                new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                    ArticlePropertyEmptyBehavior.PreserveEmpty), null, new(), options,
                type == ArticlePropertyValueType.ArticleReference ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget,
                    false, false, false, false, false) : null,
                type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2048, ArticlePropertyUrlNormalization.PreservePathCase) : null,
                false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.SiteEditors));
            all.Add((await definitions.GetAsync(propertyActor, s_owner, id))!);
        }
        ArticleTemplatePropertyDefault[] defaults = all.Select(definition => new ArticleTemplatePropertyDefault(
            definition.DefinitionId, (ArticleTemplatePropertyValueKind)definition.ValueType, Scalar(definition.ValueType),
            definition.Options.Select(static option => option.OptionId).Take(definition.ValueType == ArticlePropertyValueType.SingleSelect ? 1 : 2).ToArray())).ToArray();
        var templates = new ArticleTemplateStore(templatePersistence, new ArticleTemplatePermissionAuthority(), references,
            new ArticleTemplateVerifier(), clock);
        ArticleTemplateWriteReceipt created = await templates.CreateAsync(new(actor, ArticleTemplateContract.SiteScope(),
            Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), 0, "Synthetic property template", null,
            ArticleTemplateSource.FromUtf8("# {{title}}\n"), new ArticleTemplateDefaults(propertyDefaults: defaults)));
        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(new(actor, created.TemplateId, created.VersionId!.Value,
            "Synthetic article", TestTemporalContext.CanonicalBusinessEpochUtc, "UTC", "en"));
        var command = new ArticleCreateCommand(actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest);
        return new(db, configuration, clock, actor, definitions, all, references, verifier, command);
    }

    private static string? Scalar(ArticlePropertyValueType type) => type switch
    {
        ArticlePropertyValueType.Text => "Synthetic typed text",
        ArticlePropertyValueType.Number => "0",
        ArticlePropertyValueType.Boolean => "false",
        ArticlePropertyValueType.Date => TestTemporalContext.CanonicalBusinessEpochUtc.UtcDateTime.ToString("O", CultureInfo.InvariantCulture),
        ArticlePropertyValueType.Url => "https://example.com/Case",
        _ => null
    };

    // An AOP seam exercises the unmodified real writer while its real transaction is held.
    // It is test-only, fires once before outbox, and supplies identities read from the actual
    // newly inserted canonical draft. Production must use the create owner's explicit hook.
    private static Func<int> InstallParticipant(Seed data, SqlSugarClient db, ArticleCreateCommand command,
        Action<SqlSugarClient, NpgsqlTransaction, int, long>? write = null, Action? after = null, string? failureStage = null)
    {
        int calls = 0;
        bool inside = false;
        db.Aop.OnLogExecuting = (sql, parameters) =>
        {
            if (failureStage is not null && IsWrite(sql, failureStage switch
            {
                "factset" => "article_property_value_factset",
                "entry" => "article_property_value_entry",
                "snapshot" => "article_property_value_snapshot",
                "head" => "article_property_value_head",
                "create-receipt" => "article_create_receipt",
                _ => "no-injected-sql-stage"
            }))
            {
                throw new IOException("isolated SQL failure: " + failureStage);
            }
            if (inside || !IsWrite(sql, "article_mutation_outbox"))
            {
                return;
            }
            inside = true;
            try
            {
                calls++;
                string draftKey = $"canonical-create:{command.RequestId:N}";
                int article = db.Ado.GetInt("SELECT article_id FROM article_draft WHERE draft_key = @Key;", new SugarParameter("@Key", draftKey));
                long revision = db.Ado.GetLong("SELECT base_revision_id FROM article_draft WHERE draft_key = @Key;", new SugarParameter("@Key", draftKey));
                var transaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
                if (write is not null)
                {
                    write(db, transaction, article, revision);
                }
                else
                {
                    var persistence = new ArticlePropertyValuePersistence(db, data.Configuration, data.Clock);
                    _ = persistence.SaveInitialCreateAsync(transaction, command, data.Actor, s_owner, article, revision)
                        .GetAwaiter().GetResult();
                }
                after?.Invoke();
            }
            finally
            {
                inside = false;
            }
        };
        return () => calls;
    }

    private static bool IsWrite(string sql, string table)
        => sql.TrimStart().StartsWith("INSERT", StringComparison.OrdinalIgnoreCase)
            && sql.Contains(table, StringComparison.Ordinal);

    private static Task<ArticleCreateReceipt> ExecuteAsync(Seed data, SqlSugarClient db, ArticleCreateCommand command)
    {
        ArticleTemplateExpansionPlan plan = command.Plan!;
        var payload = new ArticleCreatePayload(plan.Input.Title!, plan.Defaults.SummaryPlaceholder,
            plan.Defaults.CategoryId ?? 0, plan.Defaults.TagIds, Encoding.UTF8.GetString(plan.ExpandedSource),
            plan.Defaults.AssetIds.Select(static asset => asset.Value).ToArray(), plan.ExpandedSourceDigest,
            plan.DefaultsDigest, plan.ContentDigest);
        return new PostgresArticleCreatePersistence(db, data.Configuration).ExecuteAsync(command, payload,
            ArticleCreateStore.ComputeRequestDigest(command));
    }

    private static async Task<bool> ReceiptMatchesWrittenAggregateAsync(Seed data, ArticleCreateReceipt receipt,
        ArticleCreateCommand command)
    {
        ArticleCreateVerificationSnapshot? aggregate = await new PostgresArticleCreatePersistence(data.Db, data.Configuration)
            .ReadVerificationSnapshotAsync(receipt.ReceiptId);
        if (aggregate is null || aggregate.Receipt != receipt with
        {
            IsIdempotentReplay = false
        }
            || !ArticleCreateVerifier.Verify(aggregate).Valid || receipt.PlanDigest != command.PlanDigest
            || receipt.RequestId != command.RequestId || receipt.OwnerAdminPrincipalId != command.Actor.AdminPrincipalId)
        {
            return false;
        }
        try
        {
            ArticlePropertyValuePersistedSnapshot? written = await data.Properties.ReadCurrentAsync(s_owner,
                receipt.ArticleId, receipt.RevisionId);
            ArticlePropertyValueSnapshot expected = ArticlePropertyValueValidator.BindSnapshot(
                new(s_owner.UserId, s_owner.SiteScope, receipt.ArticleId, 1, receipt.RevisionId),
                command.Plan!.Dependencies.PropertyPins.Select(static pin => pin.ValidatedValue).ToArray());
            return written is not null && written.Snapshot.ContentDigest == expected.ContentDigest;
        }
        catch (ArticlePropertyDefinitionIntegrityException)
        {
            return false;
        }
        catch (ArticlePropertyDefinitionValidationException)
        {
            return false;
        }
    }

    private static ArticleTemplateExpansionPlan ChangePlan(ArticleTemplateExpansionPlan plan, string mutation)
    {
        ArticleTemplateDefaults defaults = mutation switch
        {
            "defaults-replaced" => new ArticleTemplateDefaults(),
            "defaults-value-replaced" => new ArticleTemplateDefaults(propertyDefaults: plan.Defaults.PropertyDefaults.Select(value =>
                value.ValueKind == ArticleTemplatePropertyValueKind.Text
                    ? new ArticleTemplatePropertyDefault(value.DefinitionId, value.ValueKind, "replaced", value.OptionIds) : value).ToArray()),
            _ => plan.Defaults
        };
        ArticleTemplatePropertyPin[] pins = mutation == "pinless-resealed" ? [] : plan.Dependencies.PropertyPins.ToArray();
        if (mutation == "typed-value-resealed")
        {
            pins = pins.Select(pin => pin.ValueType == ArticlePropertyValueType.Text ? pin with
            {
                ValidatedValue = pin.ValidatedValue with
                {
                    Value = new ArticlePropertyTextValue("forged")
                }
            } : pin).ToArray();
        }
        var dependencies = new ArticleTemplateExpansionDependencies(plan.Dependencies.CategoryId, plan.Dependencies.TagIds,
            plan.Dependencies.AssetPins, plan.Dependencies.PropertyDefaults, plan.Dependencies.RightsProfile,
            plan.Dependencies.ResponsibilityProfile, plan.Dependencies.PrepublishProfile, pins);
        return new(plan.Input, plan.VersionId, plan.VersionNumber, plan.TemplateRevision, plan.Scope,
            mutation == "source-replaced" ? Encoding.UTF8.GetBytes("replaced") : plan.ExpandedSource,
            plan.ExpandedSourceDigest, defaults, plan.DefaultsDigest, dependencies, plan.Warnings,
            plan.IssuedAtUtc, plan.ExpiresAtUtc);
    }

    private static async Task<long> CountAsync(SqlSugarClient db, string table)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT count(*) FROM " + table), CultureInfo.InvariantCulture);

    private static async Task<long[]> CountsAsync(SqlSugarClient db)
    {
        var counts = new List<long>();
        foreach (string table in s_tables)
        {
            counts.Add(await CountAsync(db, table));
        }
        return counts.ToArray();
    }

    private sealed record Seed(SqlSugarClient Db, IConfiguration Configuration, TimeProvider Clock,
        ArticleTemplateActor Actor, ArticlePropertyDefinitionStore DefinitionStore,
        IReadOnlyList<ArticlePropertyDefinition> Definitions, PostgresArticleTemplateReferenceAuthority References,
        ArticleTemplateExpansionVerifier Verifier, ArticleCreateCommand Command) : IDisposable
    {
        public ArticleTemplateExpansionPlan Plan => Command.Plan!;
        public ArticlePropertyValuePersistence Properties => new(Db, Configuration, Clock);
        public void Dispose() => Db.Dispose();
    }
}
