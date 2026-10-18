using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleTemplateExpansionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "article-template-expansion-key-0123456789";
    private static readonly ArticleTemplateActor s_writer = new(
        9,
        [AdminPermissions.ArticleWrite]);

    [Fact]
    public async Task Planner_ProducesDeterministicPlanFromPostgresAuthorities()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var persistence = new PostgresArticleTemplatePersistence(db, CreateConfiguration());
        var references = new PostgresArticleTemplateReferenceAuthority(db);
        var expansionAuthority = new PostgresArticleTemplateExpansionAuthority(db);
        var store = new ArticleTemplateStore(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references,
            new ArticleTemplateVerifier(),
            TimeProvider.System);
        var planner = new ArticleTemplateExpansionPlanner(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references,
            expansionAuthority,
            TimeProvider.System);
        var verifier = new ArticleTemplateExpansionVerifier(planner, TimeProvider.System);
        ArticleTemplateScope scope = ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId);

        ArticleTemplateWriteReceipt created = await store.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            scope,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Release Notes",
            null,
            ArticleTemplateSource.FromUtf8("# {{title}}\n\nby {{author}} on {{date}} ({{site_locale}})\n"),
            new ArticleTemplateDefaults(
                categoryId: 11,
                tagIds: [21],
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_publicAssetId)])));

        var input = new ArticleTemplateExpansionInput(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value,
            "Quarterly *Report*",
            new DateTimeOffset(2026, 9, 8, 23, 30, 0, TimeSpan.Zero),
            "Asia/Shanghai",
            "en");
        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(input);

        string expanded = System.Text.Encoding.UTF8.GetString(plan.ExpandedSource);
        Assert.Equal(
            "# Quarterly \\*Report\\*\n\nby Alice Admin on 2026-09-09 (en-US)\n",
            expanded);
        Assert.Equal(11, plan.Dependencies.CategoryId);
        Assert.Equal([21], plan.Dependencies.TagIds);
        ArticleTemplateAssetPin pin = Assert.Single(plan.Dependencies.AssetPins);
        Assert.Equal(s_publicAssetId, pin.AssetId);
        Assert.Equal("active", pin.State);
        Assert.Equal("public", pin.StorageClass);

        ArticleTemplateVerificationResult valid = await verifier.VerifyAsync(plan);
        Assert.True(valid.Valid, string.Join(',', valid.Violations.Select(static v => v.Code)));

        // Drift in durable reference state is detected by independent recomputation.
        await db.Ado.ExecuteCommandAsync("DELETE FROM tag WHERE id = 21;");
        ArticleTemplateVerificationResult drifted = await verifier.VerifyAsync(plan);
        Assert.False(drifted.Valid);
        Assert.Contains(drifted.Violations, v => v.Code == "expansion_plan_reference_stale");
    }

    [Fact]
    public async Task Planner_FailsClosedWhenActorPrincipalOrAssetIsGone()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var expansionAuthority = new PostgresArticleTemplateExpansionAuthority(db);

        await Assert.ThrowsAsync<ArticleTemplateExpansionException>(
            () => expansionAuthority.ResolveActorDisplayNameAsync(99999));
        Assert.Equal(
            "article_template_asset_reference_stale",
            (await Assert.ThrowsAsync<ArticleTemplateExpansionException>(
                () => expansionAuthority.PinAssetsAsync([Guid.CreateVersion7()]))).Code);
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task Planner_PinsRealDefinitionsAndCanonicalTypedValuesWithoutWrites(ArticlePropertyValueType type)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, type);
        long before = await CountAuthorityWritesAsync(db);
        ArticleTemplateExpansionPlan plan = await context.Planner.PlanAsync(context.Input);
        ArticleTemplatePropertyPin pin = Assert.Single(plan.Dependencies.PropertyPins);

        Assert.Equal(context.Definition.Owner, pin.Owner);
        Assert.Equal(context.Definition.DefinitionId, pin.DefinitionId);
        Assert.Equal(context.Definition.SchemaRevision, pin.SchemaRevision);
        Assert.Equal(context.Definition.ContentDigest, pin.DefinitionDigest);
        Assert.Equal(type, pin.ValueType);
        Assert.Equal(context.Definition.Cardinality, pin.Cardinality);
        Assert.Equal(ArticlePropertyDefinitionStatus.Active, pin.Status);
        Assert.Equal(ArticlePropertyDefinitionContract.ComputeConstraintDigest(context.Definition.Constraints), pin.ConstraintDigest);
        Assert.Equal(ArticlePropertyDefinitionContract.ComputeOptionsDigest(context.Definition.Options), pin.OptionsDigest);
        Assert.Equal(ArticlePropertyDefinitionContract.ComputePolicyDigest(
            context.Definition.ReferencePolicy, context.Definition.UrlPolicy), pin.PolicyDigest);
        Assert.Equal(ArticlePropertyValuePresence.Present, pin.ValidatedValue.Presence);
        Assert.False(pin.ValidatedValue.DefaultApplied);
        if (type == ArticlePropertyValueType.Number)
        {
            Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(pin.ValidatedValue.Value).Number);
        }
        if (type == ArticlePropertyValueType.Boolean)
        {
            Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(pin.ValidatedValue.Value).Boolean);
        }
        if (type == ArticlePropertyValueType.ArticleReference)
        {
            Assert.Empty(Assert.IsType<ArticlePropertyArticleReferenceValue>(pin.ValidatedValue.Value).ArticleIds);
        }
        Assert.True((await context.Verifier.VerifyAsync(plan, s_writer, context.Definition.Owner)).Valid);
        Assert.Equal(plan.ContentDigest, (await context.Planner.PlanAsync(context.Input)).ContentDigest);
        Assert.Equal(before, await CountAuthorityWritesAsync(db));
    }

    [Theory]
    [InlineData("constraints")]
    [InlineData("options")]
    [InlineData("option-deprecated")]
    [InlineData("type")]
    [InlineData("deprecated")]
    [InlineData("deleted")]
    public async Task Verifier_BindsCanonicalDefinitionChangesAndTypeIdentity(string drift)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db,
            drift is "options" or "option-deprecated" ? ArticlePropertyValueType.SingleSelect : ArticlePropertyValueType.Number);
        ArticleTemplateExpansionPlan old = await context.Planner.PlanAsync(context.Input);
        ArticlePropertyDefinition definition = context.Definition;
        var actor = new ArticlePropertyDefinitionActor(s_writer.AdminPrincipalId, s_writer.Permissions);
        if (drift == "deprecated")
        {
            await context.Definitions.DeprecateAsync(new(actor, definition.Owner, definition.DefinitionId,
                Guid.CreateVersion7(), 1, definition.SchemaRevision));
        }
        else if (drift == "deleted")
        {
            ArticlePropertyDefinitionWriteReceipt deprecated = await context.Definitions.DeprecateAsync(new(
                actor, definition.Owner, definition.DefinitionId, Guid.CreateVersion7(), 1, definition.SchemaRevision));
            await context.Definitions.DeleteAsync(new(actor, definition.Owner, definition.DefinitionId,
                Guid.CreateVersion7(), deprecated.OwnerRevision, deprecated.SchemaRevision));
        }
        else
        {
            var update = new UpdateArticlePropertyDefinitionCommand(actor, definition.Owner, definition.DefinitionId,
                Guid.CreateVersion7(), 1, definition.SchemaRevision,
                drift == "type" ? ArticlePropertyValueType.Text : definition.ValueType,
                definition.Cardinality, definition.Required, definition.Presence, definition.DefaultValue,
                drift == "constraints" ? new ArticlePropertyConstraints(MinNumber: -1, MaxNumber: 1) : new(),
                drift switch
                {
                    "options" => [definition.Options[0] with { Label = "Renamed stable option" }],
                    "option-deprecated" => [definition.Options[0] with { Status = ArticlePropertyOptionStatus.Deprecated }],
                    _ => definition.Options
                },
                definition.ReferencePolicy, definition.UrlPolicy, definition.SearchEligible, definition.Filterable,
                definition.Sortable, definition.DisplayPlacement, definition.VisibilityScope);
            if (drift == "type")
            {
                Assert.Equal("article_property_type_change_requires_new_definition",
                    (await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => context.Definitions.UpdateAsync(update))).Code);
                await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => context.References.ValidateAndPinAsync(
                    s_writer, old.Scope, new(propertyDefaults:
                        [new(definition.DefinitionId, ArticleTemplatePropertyValueKind.Text, "0")])));
                Assert.True((await context.Verifier.VerifyAsync(old)).Valid);
                return;
            }
            await context.Definitions.UpdateAsync(update);
        }
        ArticleTemplateVerificationResult result = await context.Verifier.VerifyAsync(old);
        Assert.False(result.Valid);
        if (drift is "constraints" or "options")
        {
            ArticleTemplateExpansionPlan current = await context.Planner.PlanAsync(context.Input);
            ArticleTemplatePropertyPin before = Assert.Single(old.Dependencies.PropertyPins);
            ArticleTemplatePropertyPin after = Assert.Single(current.Dependencies.PropertyPins);
            Assert.NotEqual(before.DefinitionDigest, after.DefinitionDigest);
            Assert.NotEqual(drift == "constraints" ? before.ConstraintDigest : before.OptionsDigest,
                drift == "constraints" ? after.ConstraintDigest : after.OptionsDigest);
            Assert.NotEqual(old.ContentDigest, current.ContentDigest);
        }
        else
        {
            Assert.Contains(result.Violations, static violation => violation.Code == "expansion_plan_reference_stale");
        }
        IArticleCreatePersistence writer = Substitute.For<IArticleCreatePersistence>();
        var create = new ArticleCreateStore(writer, context.Verifier);
        ArticleCreateException refused = await Assert.ThrowsAsync<ArticleCreateException>(() => create.CreateAsync(
            new(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template, old.Input.TemplateId,
                old.VersionId, old, old.ContentDigest)));
        Assert.StartsWith("article_create_plan_stale:", refused.Code);
        await writer.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("permission")]
    [InlineData("owner")]
    [InlineData("site")]
    public async Task Verifier_RejectsCreateContextDrift(string drift)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Text);
        ArticleTemplateExpansionPlan plan = await context.Planner.PlanAsync(context.Input);
        ArticleTemplateActor currentActor = drift switch
        {
            "actor" => new(77, s_writer.Permissions),
            "permission" => new(s_writer.AdminPrincipalId, []),
            _ => s_writer
        };
        ArticlePropertyDefinitionOwner owner = context.Definition.Owner;
        ArticlePropertyDefinitionOwner currentOwner = drift switch
        {
            "owner" => owner with { UserId = 77 },
            "site" => owner with { SiteScope = "another-synthetic-site" },
            _ => owner
        };
        ArticleTemplateVerificationResult result = await context.Verifier.VerifyAsync(plan, currentActor, currentOwner);
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "expansion_plan_context_drift");

        var wrongOwner = new PostgresArticleTemplateReferenceAuthority(db, context.Definitions,
            PropertyValidator(context.Definitions), currentOwner);
        if (drift is "owner" or "site")
        {
            await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => wrongOwner.ValidateAndPinAsync(
                s_writer, plan.Scope, plan.Defaults));
        }
        if (drift == "permission")
        {
            await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() => wrongOwner.ValidateAndPinAsync(
                currentActor, plan.Scope, plan.Defaults));
        }
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Number, "100")]
    [InlineData(ArticlePropertyValueType.Boolean, "not-a-boolean")]
    [InlineData(ArticlePropertyValueType.Date, "not-a-date")]
    [InlineData(ArticlePropertyValueType.SingleSelect, "unknown-option")]
    [InlineData(ArticlePropertyValueType.Url, "javascript:alert(1)")]
    public async Task References_RejectInvalidDefaultsThroughCanonicalValidation(ArticlePropertyValueType type, string invalid)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, type);
        ArticleTemplatePropertyDefault value = type == ArticlePropertyValueType.SingleSelect
            ? new(context.Definition.DefinitionId, ArticleTemplatePropertyValueKind.SingleSelect, null, [Guid.CreateVersion7()])
            : new(context.Definition.DefinitionId, (ArticleTemplatePropertyValueKind)type, invalid);
        await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => context.References.ValidateAndPinAsync(
            s_writer, ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId), new(propertyDefaults: [value])));
    }

    [Theory]
    [InlineData("8")]
    [InlineData("[8]")]
    [InlineData("[]")]
    [InlineData("")]
    public void References_NeverInterpretArticleReferenceStrings(string candidate)
    {
        Assert.Throws<ArticleTemplateReferenceException>(() => new ArticleTemplateDefaults(propertyDefaults:
            [new(Guid.CreateVersion7(), ArticleTemplatePropertyValueKind.ArticleReference, candidate)]));
    }

    [Theory]
    [InlineData("pinless")]
    [InlineData("constraints")]
    [InlineData("options")]
    [InlineData("value")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("revision")]
    [InlineData("digest")]
    [InlineData("type")]
    [InlineData("cardinality")]
    [InlineData("status")]
    [InlineData("policy")]
    public async Task Verifier_RejectsPinlessReplayAndResealedPinTamper(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Number);
        ArticleTemplateExpansionPlan plan = await context.Planner.PlanAsync(context.Input);
        ArticleTemplatePropertyPin pin = Assert.Single(plan.Dependencies.PropertyPins);
        ArticleTemplatePropertyPin changed = mutation switch
        {
            "constraints" => pin with { ConstraintDigest = new string('0', 64) },
            "options" => pin with { OptionsDigest = new string('0', 64) },
            "value" => pin with { ValidatedValue = pin.ValidatedValue with { Value = new ArticlePropertyNumberValue(1) } },
            "owner" => pin with { Owner = pin.Owner with { UserId = 77 } },
            "site" => pin with { Owner = pin.Owner with { SiteScope = "another-synthetic-site" } },
            "revision" => pin with { SchemaRevision = pin.SchemaRevision + 1 },
            "digest" => pin with { DefinitionDigest = new string('0', 64) },
            "type" => pin with { ValueType = ArticlePropertyValueType.Text },
            "cardinality" => pin with { Cardinality = ArticlePropertyCardinality.Multiple },
            "status" => pin with { Status = ArticlePropertyDefinitionStatus.Deprecated },
            "policy" => pin with { PolicyDigest = new string('0', 64) },
            _ => pin
        };
        ArticleTemplateExpansionDependencies original = plan.Dependencies;
        var dependencies = new ArticleTemplateExpansionDependencies(original.CategoryId, original.TagIds, original.AssetPins,
            original.PropertyDefaults, original.RightsProfile, original.ResponsibilityProfile, original.PrepublishProfile,
            mutation == "pinless" ? [] : [changed]);
        // Constructing a new plan recomputes its outer digest; matching that hash grants no authority.
        var candidate = new ArticleTemplateExpansionPlan(plan.Input, plan.VersionId, plan.VersionNumber,
            plan.TemplateRevision, plan.Scope, plan.ExpandedSource, plan.ExpandedSourceDigest, plan.Defaults,
            plan.DefaultsDigest, dependencies, plan.Warnings, plan.IssuedAtUtc, plan.ExpiresAtUtc);
        Assert.NotEqual(plan.ContentDigest, candidate.ContentDigest);
        ArticleTemplateVerificationResult result = await context.Verifier.VerifyAsync(candidate);
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "expansion_plan_recompute_mismatch");
    }

    [Fact]
    public async Task References_RequireExplicitAuthorityOwnerAndHonorCancellation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Text);
        ArticleTemplateExpansionPlan plan = await context.Planner.PlanAsync(context.Input);
        foreach (PostgresArticleTemplateReferenceAuthority unavailable in new[]
                 {
                     new PostgresArticleTemplateReferenceAuthority(db),
                     new PostgresArticleTemplateReferenceAuthority(db, context.Definitions, PropertyValidator(context.Definitions))
                 })
        {
            Assert.Equal("article_template_property_authority_unavailable",
                (await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => unavailable.ValidateAndPinAsync(
                    s_writer, plan.Scope, plan.Defaults))).Code);
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.References.ValidateAndPinAsync(
            s_writer, plan.Scope, plan.Defaults, new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task CreateBinding_RejectsTheOriginalPinlessDigestFormat()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Number);
        ArticleTemplateExpansionPlan plan = await context.Planner.PlanAsync(context.Input);
        ArticleTemplatePropertyDefault value = Assert.Single(plan.Defaults.PropertyDefaults);
        // Exact #3988 digest field sequence for this synthetic no-taxonomy/asset/profile plan.
        // The historical format has neither the typed pin domain nor definition/value pins.
        string legacyDigest = ArticleTemplateContract.ComputeCommandDigest(
            ArticleTemplateContract.SchemaVersion, plan.Input.TemplateId, plan.Input.VersionId, plan.VersionNumber,
            plan.TemplateRevision, (int)plan.Scope.Kind, plan.Scope.OwnerAdminPrincipalId,
            plan.Input.Actor.AdminPrincipalId, ArticleTemplateContract.ComputeExpansionInputDigest(plan.Input),
            plan.ExpandedSourceDigest, plan.DefaultsDigest, 0,
            null, 0, 0, 1, value.DefinitionId, (int)value.ValueKind, value.CanonicalValue, 0,
            null, null, null, null, null, null);

        Assert.NotEqual(legacyDigest, plan.ContentDigest);
        Assert.Equal("article_create_plan_binding_invalid", Assert.Throws<ArticleCreateValidationException>(() =>
            new ArticleCreateCommand(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template,
                plan.Input.TemplateId, plan.VersionId, plan, legacyDigest)).Code);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("title")]
    [InlineData("summary")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("assets")]
    [InlineData("property-value")]
    [InlineData("rights")]
    [InlineData("responsibility")]
    [InlineData("prepublish")]
    public async Task DefaultsReplacement_IsRejectedBeforeTheCreateWriter(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Number);
        var input = new ArticleTemplateExpansionInput(s_writer, context.Input.TemplateId, context.Input.VersionId,
            null, context.Input.BusinessTimeUtc, context.Input.TimeZoneId, context.Input.LocaleCode);
        ArticleTemplateExpansionPlan original = await context.Planner.PlanAsync(input);
        ArticleTemplatePropertyDefault property = Assert.Single(original.Defaults.PropertyDefaults);
        var replacement = new ArticleTemplateDefaults(
            titlePlaceholder: mutation == "title" ? "Unsealed title" : null,
            summaryPlaceholder: mutation == "summary" ? "Unsealed summary" : null,
            categoryId: mutation == "category" ? 777 : null,
            tagIds: mutation == "tags" ? [777] : [],
            assetIds: mutation == "assets" ? [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(Guid.CreateVersion7())] : [],
            propertyDefaults: mutation == "property-value"
                ? [new(property.DefinitionId, property.ValueKind, "1")] : [],
            rightsProfile: mutation == "rights" ? new(Guid.CreateVersion7(), 1) : null,
            responsibilityProfile: mutation == "responsibility" ? new(Guid.CreateVersion7(), 1) : null,
            prepublishProfile: mutation == "prepublish" ? new(Guid.CreateVersion7(), 1) : null);
        ArticleTemplateExpansionPlan candidate = WithDefaults(original, replacement, original.DefaultsDigest);
        Assert.Same(original.Dependencies, candidate.Dependencies);
        Assert.Equal(original.DefaultsDigest, candidate.DefaultsDigest);
        Assert.Single(candidate.Dependencies.PropertyPins);

        ArticleTemplateVerificationResult ordinary = await context.Verifier.VerifyAsync(candidate);
        ArticleTemplateVerificationResult current = await context.Verifier.VerifyAsync(candidate, s_writer, context.Definition.Owner);
        IArticleCreatePersistence writer = Substitute.For<IArticleCreatePersistence>();
        var create = new ArticleCreateStore(writer, context.Verifier);
        Exception? refusal = await Record.ExceptionAsync(() => create.CreateAsync(new(s_writer, Guid.CreateVersion7(),
            ArticleCreateMode.Template, candidate.Input.TemplateId, candidate.VersionId, candidate, candidate.ContentDigest)));
        int writerCalls = writer.ReceivedCalls().Count(static call => call.GetMethodInfo().Name == nameof(IArticleCreatePersistence.ExecuteAsync));

        Assert.True(!ordinary.Valid && !current.Valid && writerCalls == 0 && refusal is ArticleCreateException,
            $"Defaults substitution: sameSeal={original.ContentDigest == candidate.ContentDigest}; "
            + $"ordinaryValid={ordinary.Valid}; currentValid={current.Valid}; writerCalls={writerCalls}; refusal={refusal?.GetType().Name ?? "none"}");
        Assert.NotEqual(original.ContentDigest, candidate.ContentDigest);
        Assert.Contains(ordinary.Violations, static violation => violation.Code == "expansion_plan_defaults_digest_mismatch");
        Assert.Throws<ArticleCreateValidationException>(() => new ArticleCreateCommand(s_writer, Guid.CreateVersion7(),
            ArticleCreateMode.Template, candidate.Input.TemplateId, candidate.VersionId, candidate, original.ContentDigest));
        await writer.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!);
    }

    [Fact]
    public async Task DefaultsReplacement_WithARecomputedDeclarationStillCannotReplaceCanonicalDependencies()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Number);
        ArticleTemplateExpansionPlan original = await context.Planner.PlanAsync(context.Input);
        var replacement = new ArticleTemplateDefaults(summaryPlaceholder: "Resealed summary");
        ArticleTemplateExpansionPlan candidate = WithDefaults(original, replacement, ArticleTemplateContract.ComputeDefaultsDigest(replacement));

        Assert.Same(original.Dependencies, candidate.Dependencies);
        Assert.NotEqual(original.ContentDigest, candidate.ContentDigest);
        ArticleTemplateVerificationResult result = await context.Verifier.VerifyAsync(candidate);
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "expansion_plan_recompute_mismatch");
    }

    private static ArticleTemplateExpansionPlan WithDefaults(
        ArticleTemplateExpansionPlan plan, ArticleTemplateDefaults defaults, string declaredDigest)
        => new(plan.Input, plan.VersionId, plan.VersionNumber, plan.TemplateRevision, plan.Scope,
            plan.ExpandedSource, plan.ExpandedSourceDigest, defaults, declaredDigest, plan.Dependencies,
            plan.Warnings, plan.IssuedAtUtc, plan.ExpiresAtUtc);

    [Fact]
    public async Task DefaultsReplacement_RejectsADeclarationThatDoesNotDescribeTheConsumedObject()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PropertyPlanContext context = await CreatePropertyPlanAsync(db, ArticlePropertyValueType.Number);
        ArticleTemplateExpansionPlan original = await context.Planner.PlanAsync(context.Input);
        ArticleTemplateExpansionPlan candidate = WithDefaults(original, original.Defaults, new string('0', 64));

        Assert.Equal(original.ContentDigest, candidate.ContentDigest);
        ArticleTemplateVerificationResult result = await context.Verifier.VerifyAsync(candidate);
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "expansion_plan_defaults_digest_mismatch");
        Assert.True((await context.Verifier.VerifyAsync(original)).Valid);
    }

    private static readonly Guid s_optionId = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static ArticlePropertyValueValidator PropertyValidator(ArticlePropertyDefinitionStore definitions)
        => new(definitions, new ArticlePropertyDefinitionPermissionAuthority(), new UnavailableArticlePropertyReferenceValueAuthority());

    private static async Task<PropertyPlanContext> CreatePropertyPlanAsync(SqlSugarClient db, ArticlePropertyValueType type)
    {
        IConfiguration configuration = CreateConfiguration();
        var definitions = new ArticlePropertyDefinitionStore(new PostgresArticlePropertyDefinitionPersistence(db, configuration),
            new ArticlePropertyDefinitionPermissionAuthority(), new EmptyArticleValueFixtureImpact(),
            new ArticlePropertyDefinitionVerifier(configuration), TimeProvider.System);
        var actor = new ArticlePropertyDefinitionActor(s_writer.AdminPrincipalId, s_writer.Permissions);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(s_writer.AdminPrincipalId, "template-synthetic-site");
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        bool select = type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect;
        ArticlePropertyCardinality cardinality = multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        Guid id = Guid.CreateVersion7();
        await definitions.CreateAsync(new(actor, owner, id, Guid.CreateVersion7(), 0, "template-property",
            [new("en", "Synthetic property")], type, cardinality, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), null,
            type == ArticlePropertyValueType.Number ? new(MinNumber: -10, MaxNumber: 10) : new(),
            select ? [new(s_optionId, "Stable option", 0, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference ? new(cardinality,
                ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2048,
                ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly));
        ArticlePropertyDefinition definition = (await definitions.GetAsync(actor, owner, id))!;
        var references = new PostgresArticleTemplateReferenceAuthority(db, definitions, PropertyValidator(definitions), owner);
        var persistence = new PostgresArticleTemplatePersistence(db, configuration);
        var templates = new ArticleTemplateStore(persistence, new ArticleTemplatePermissionAuthority(), references,
            new ArticleTemplateVerifier(), TimeProvider.System);
        string? scalar = type switch
        {
            ArticlePropertyValueType.Text => "Synthetic text",
            ArticlePropertyValueType.Number => "0",
            ArticlePropertyValueType.Boolean => "false",
            ArticlePropertyValueType.Date => "2026-10-08T12:00:00.0000000Z",
            ArticlePropertyValueType.Url => "https://example.com/path",
            _ => null
        };
        ArticleTemplateWriteReceipt created = await templates.CreateAsync(new(s_writer,
            ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId), Guid.CreateVersion7(), Guid.CreateVersion7(),
            Guid.CreateVersion7(), 0, "Typed synthetic template", null, ArticleTemplateSource.FromUtf8("plain"),
            new(propertyDefaults: [new(id, (ArticleTemplatePropertyValueKind)type, scalar, select ? [s_optionId] : [])])));
        var planner = new ArticleTemplateExpansionPlanner(persistence, new ArticleTemplatePermissionAuthority(), references,
            new PostgresArticleTemplateExpansionAuthority(db), TimeProvider.System);
        var input = new ArticleTemplateExpansionInput(s_writer, created.TemplateId, created.VersionId!.Value,
            "Typed", new(2026, 10, 8, 12, 0, 0, TimeSpan.Zero), "UTC", "en");
        return new(definitions, definition, references, planner, new(planner, TimeProvider.System), input);
    }

    private static Task<long> CountAuthorityWritesAsync(SqlSugarClient db)
        => db.Ado.SqlQuerySingleAsync<long>("""
            SELECT (SELECT count(*) FROM article_template_receipt)
                + (SELECT count(*) FROM article_property_definition_receipt)
                + (SELECT count(*) FROM sys_audit_log);
            """);

    private sealed record PropertyPlanContext(
        ArticlePropertyDefinitionStore Definitions,
        ArticlePropertyDefinition Definition,
        PostgresArticleTemplateReferenceAuthority References,
        ArticleTemplateExpansionPlanner Planner,
        ArticleTemplateExpansionVerifier Verifier,
        ArticleTemplateExpansionInput Input);

    // This task database contains definition/template authorities and no article/value ledger.
    // Supply the same known-empty impact fixture as the original definition lifecycle tests.
    private sealed class EmptyArticleValueFixtureImpact : IArticlePropertyDefinitionImpactAuthority
    {
        public Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
            ArticlePropertyDefinitionOwner owner,
            ArticlePropertyDefinition? before,
            ArticlePropertyDefinition after,
            string commandKind,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new ArticlePropertyDefinitionImpact(0, []));
    }

    private static readonly Guid s_publicAssetId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(ContentAsset),
            typeof(AdminPrincipal),
            typeof(AuditLog));
        await db.Ado.ExecuteCommandAsync("""
            INSERT INTO "category"(id, name) VALUES (11, 'engineering');
            INSERT INTO "tag"(id, name) VALUES (21, 'release'), (22, 'notes');
            INSERT INTO content_asset(
                id, storage_class, storage_key, media_type, extension, byte_length,
                owner_admin_principal_id, state, created_at_utc, updated_at_utc)
            VALUES
                (@PublicId, 'public', 'assets/public.png', 'image/png', 'png', 128,
                 NULL, 'active', now(), now());
            INSERT INTO admin_principal(
                handle, displayname, status, isroot, permissions, createdatutc)
            VALUES
                ('alice', 'Alice Admin', 'active', false, '[]', now());
            """,
            new SugarParameter("@PublicId", s_publicAssetId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET id = 9 WHERE handle = 'alice';");
        foreach (ISchemaMigrationDescriptor migration in new[]
                 {
                     ArticleTemplateAuthorityMigrationDefinitions.BuildMigration(),
                     ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
                     ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration()
                 })
        {
            foreach (SchemaMigrationStep step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
        return db;
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();
}
