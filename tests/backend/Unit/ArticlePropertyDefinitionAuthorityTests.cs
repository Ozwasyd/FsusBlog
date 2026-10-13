using System.Data;
using System.Globalization;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePropertyDefinitionAuthorityTests
{
    private const string TestAuditKey = "property-definition-test-audit-key-20261002-distinct-value";
    private static readonly byte[] s_auditKey = Encoding.UTF8.GetBytes(TestAuditKey);

    private static ArticlePropertyDefinitionVerifier CreateVerifier()
        => new(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Audit:TamperEvidenceKey"] = TestAuditKey }).Build());

    private static readonly ArticlePropertyDefinitionActor s_actor = new(
        42,
        [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig]);

    [Fact]
    public async Task Store_Accepts_All_Eight_Closed_Types_And_Paginates_Definitions()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "site-a");
        ArticlePropertyValueType[] types = Enum.GetValues<ArticlePropertyValueType>();

        for (int index = 0; index < types.Length; index++)
        {
            ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(
                CreateCommand(owner, types[index], index, index));
            Assert.Equal(1, receipt.SchemaRevision);
            Assert.Equal(index + 1, receipt.OwnerRevision);
        }

        ArticlePropertyDefinitionPage page = await store.ListAsync(s_actor, owner, null, 100);
        Assert.Equal(types.Length, page.Items.Count);
        Assert.Equal(
            types.OrderBy(static type => ArticlePropertyDefinitionContract.TypeName(type)),
            page.Items.OrderBy(static item => item.MachineKey).Select(static item => item.ValueType));
        Assert.Null(page.NextCursor);
        Assert.Equal(types.Length, page.OwnerRevision);
    }

    [Fact]
    public async Task Lifecycle_Renames_Without_Identity_Change_And_Verifies_Receipts()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "site-lifecycle");
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(create);

        ArticlePropertyDefinitionWriteReceipt renamed = await store.RenameAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 1,
            ExpectedSchemaRevision: 1,
            [new ArticlePropertyLocalizedName("en", "Renamed display label")]));
        Assert.Equal(2, renamed.SchemaRevision);
        ArticlePropertyDefinition? afterRename = await store.GetAsync(s_actor, owner, created.DefinitionId);
        Assert.NotNull(afterRename);
        Assert.Equal("field-text-0", afterRename.MachineKey);
        Assert.Equal("Renamed display label", afterRename.PrimaryDisplayName.Value);

        ArticlePropertyDefinitionWriteReceipt changed = await store.UpdateAsync(
            UpdateCommandFor(afterRename, ownerRevision: 2, schemaRevision: 2, searchEligible: true));
        Assert.Equal(3, changed.SchemaRevision);
        ArticlePropertyDefinitionWriteReceipt deprecated = await store.DeprecateAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 3,
            ExpectedSchemaRevision: 3));
        Assert.Equal(ArticlePropertyDefinitionStatus.Deprecated, deprecated.Status);

        ArticlePropertyDefinitionWriteReceipt deleted = await store.DeleteAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 4,
            ExpectedSchemaRevision: 4));
        Assert.Equal(ArticlePropertyDefinitionStatus.Deleted, deleted.Status);
        Assert.Null(await store.GetAsync(s_actor, owner, created.DefinitionId));

        ArticlePropertyDefinitionVerificationResult verification = await store.VerifyAsync(
            s_actor,
            owner,
            created.DefinitionId);
        Assert.True(verification.Valid, string.Join(',', verification.Violations.Select(static item => item.Code)));
        Assert.Equal(5, persistence.Receipts.Count);
        Assert.All(persistence.Receipts.Skip(2), static receipt =>
            Assert.Contains(receipt.Obligations, static obligation => obligation.RequiresReconciliation));
    }

    [Fact]
    public async Task CAS_Rejects_Stale_And_Type_Mutation_And_Idempotency_Is_Exactly_Once()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "site-cas");
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);

        ArticlePropertyDefinitionWriteReceipt[] raced = await Task.WhenAll(
            store.CreateAsync(create),
            store.CreateAsync(create));
        Assert.Equal(raced[0].ReceiptId, raced[1].ReceiptId);
        Assert.Single(raced, static receipt => receipt.IsIdempotentReplay);
        ArticlePropertyDefinitionWriteReceipt created = raced[0];

        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.CreateAsync(
            create with
            {
                MachineKey = "other-machine-key"
            }));
        ArticlePropertyDefinition? current = await store.GetAsync(s_actor, owner, created.DefinitionId);
        Assert.NotNull(current);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.UpdateAsync(
            UpdateCommandFor(current, ownerRevision: 0, schemaRevision: 1)));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.UpdateAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 1,
            ExpectedSchemaRevision: 1,
            ArticlePropertyValueType.Number,
            ArticlePropertyCardinality.Single,
            Required: false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null,
            new(MinNumber: 0, MaxNumber: 10),
            [],
            null,
            null,
            SearchEligible: false,
            Filterable: false,
            Sortable: false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors)));
        Assert.Equal(1, (await store.GetAsync(s_actor, owner, created.DefinitionId))!.SchemaRevision);
    }

    [Fact]
    public async Task Options_Keep_Stable_Ids_And_Reject_Duplicate_Unknown_Or_Deleted_Defaults()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "site-options");
        Guid optionId = Guid.CreateVersion7();
        ArticlePropertyOption option = new(optionId, "First", 0, ArticlePropertyOptionStatus.Active);
        CreateArticlePropertyDefinitionCommand create = CreateCommand(
            owner,
            ArticlePropertyValueType.SingleSelect,
            0,
            0,
            options: [option],
            defaultValue: new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId]));
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(create);
        ArticlePropertyDefinitionWriteReceipt renamed = await store.UpdateAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 1,
            ExpectedSchemaRevision: 1,
            ArticlePropertyValueType.SingleSelect,
            ArticlePropertyCardinality.Single,
            Required: false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId]),
            new(),
            [option with { Label = "Renamed" }],
            null,
            null,
            false,
            false,
            false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors));
        ArticlePropertyDefinition? current = await store.GetAsync(s_actor, owner, created.DefinitionId);
        Assert.NotNull(current);
        Assert.Equal(renamed.SchemaRevision, current.SchemaRevision);
        Assert.Equal(optionId, Assert.Single(current.Options).OptionId);
        Assert.Equal("Renamed", Assert.Single(current.Options).Label);

        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.UpdateAsync(new(
            s_actor,
            owner,
            created.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 2,
            ExpectedSchemaRevision: 2,
            ArticlePropertyValueType.SingleSelect,
            ArticlePropertyCardinality.Single,
            false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [Guid.CreateVersion7()]),
            new(),
            [option with { Label = "Renamed" }],
            null,
            null,
            false,
            false,
            false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors)));

        Guid duplicate = Guid.CreateVersion7();
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(
            CreateCommand(
                owner,
                ArticlePropertyValueType.SingleSelect,
                1,
                2,
                options: [
                    new(duplicate, "A", 0, ArticlePropertyOptionStatus.Active),
                    new(duplicate, "B", 1, ArticlePropertyOptionStatus.Active)
                ])));
    }

    [Fact]
    public void URL_And_Presence_Contracts_Fail_Closed()
    {
        ArticlePropertyUrlPolicy policy = new(
            ["https"],
            AllowRelative: false,
            AllowAbsolute: true,
            MaxLength: 128,
            ArticlePropertyUrlNormalization.LowerSchemeHost);
        Assert.Equal("https://example.com/Path", ArticlePropertyDefinitionContract.NormalizeUrl(
            "HTTPS://EXAMPLE.COM/Path",
            policy));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.NormalizeUrl(
            "javascript:alert(1)",
            policy));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.NormalizeUrl(
            "/relative",
            policy));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.ValidateDefinitionShapeForCommand(
            ArticlePropertyValueType.Text,
            ArticlePropertyCardinality.Single,
            required: true,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null,
            new(),
            [],
            null,
            null,
            false,
            false,
            false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors));
    }

    [Fact]
    public async Task Definition_Option_And_Reference_Budgets_Are_Bounded_At_1000()
    {
        Assert.Equal(1_000, ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner);
        Assert.Equal(1_000, ArticlePropertyDefinitionContract.MaxOptionsPerDefinition);
        Assert.Equal(1_000, ArticlePropertyDefinitionContract.MaxReferenceIdsPerDefault);

        var optionIds = Enumerable.Range(0, 1_000).Select(_ => Guid.CreateVersion7()).ToArray();
        ArticlePropertyOption[] options = optionIds
            .Select((id, index) => new ArticlePropertyOption(id, $"Option {index}", index, ArticlePropertyOptionStatus.Active))
            .ToArray();
        ArticlePropertyDefinitionContract.ValidateOptions(ArticlePropertyValueType.MultiSelect, options);
        Assert.Throws<ArticlePropertyDefinitionBudgetExceededException>(() =>
            ArticlePropertyDefinitionContract.ValidateOptions(
                ArticlePropertyValueType.MultiSelect,
                [.. options, new(Guid.CreateVersion7(), "Overflow", 1_000, ArticlePropertyOptionStatus.Active)]));

        ArticlePropertyDefinitionContract.ValidateDefinitionShapeForCommand(
            ArticlePropertyValueType.ArticleReference,
            ArticlePropertyCardinality.Multiple,
            required: false,
            new(ArticlePropertyMissingBehavior.ApplyDefault, ArticlePropertyNullBehavior.RejectNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: Enumerable.Range(1, 1_000).Select(static value => (long)value).ToArray()),
            new(MinItems: 0, MaxItems: 1_000),
            [],
            new(ArticlePropertyCardinality.Multiple, ArticlePropertyReferencePermission.SiteEditorMayReference, false, false, false, false, false),
            null,
            false,
            false,
            false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors);
    }

    [Fact]
    public void Closed_Registry_Has_Exact_Literal_Types_And_Rejects_Unknown_Operators()
    {
        string[] names = ["text", "number", "boolean", "date", "single-select", "multi-select", "article-reference", "url"];
        Assert.Equal(8, Enum.GetValues<ArticlePropertyValueType>().Length);
        Assert.Equal(names.Order(StringComparer.Ordinal), ArticlePropertyDefinitionContract.TypeNames.Values.Order(StringComparer.Ordinal));
        foreach (string name in names)
        {
            Assert.Equal(name, ArticlePropertyDefinitionContract.TypeName(ArticlePropertyDefinitionContract.ParseType(name)));
        }
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.TypeName((ArticlePropertyValueType)8));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.ValidateOperator("formula.eval", ArticlePropertyValueType.Text));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionContract.ValidateOperator("number.equals", ArticlePropertyValueType.Text));
    }

    [Theory]
    [InlineData("json")]
    [InlineData("object")]
    [InlineData("formula")]
    [InlineData("rollup")]
    [InlineData("script")]
    [InlineData("html")]
    [InlineData("css")]
    [InlineData("regex")]
    [InlineData("component")]
    public void Closed_Registry_Rejects_Executable_Or_Unknown_Types(string type)
    {
        ArticlePropertyDefinitionValidationException error = Assert.Throws<ArticlePropertyDefinitionValidationException>(
            () => ArticlePropertyDefinitionContract.ParseType(type));
        Assert.Equal("article_property_type_unknown", error.Code);
    }

    [Fact]
    public async Task Same_Count_Display_Names_Bind_Definition_And_Rename_Idempotency()
    {
        ArticlePropertyLocalizedName[] original = [new("en", "Original")];
        Assert.NotEqual(ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(original),
            ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest([new("en", "Changed")]));
        Assert.NotEqual(ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(original),
            ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest([new("fr", "Original")]));
        Assert.Equal(ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest([new("en", "A"), new("fr", "B")]),
            ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest([new("fr", "B"), new("en", "A")]));

        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "label-integrity");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        var command = new RenameArticlePropertyDefinitionCommand(s_actor, owner, created.DefinitionId,
            Guid.CreateVersion7(), 1, 1, original);
        ArticlePropertyDefinitionWriteReceipt renamed = await store.RenameAsync(command);
        Assert.True((await store.RenameAsync(command)).IsIdempotentReplay);
        ArticlePropertyDefinitionConflictException conflict = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(
            () => store.RenameAsync(command with { DisplayNames = [new("en", "Changed")] }));
        Assert.Equal("article_property_idempotency_conflict", conflict.Code);
        Assert.Equal(2, persistence.Receipts.Count);
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
        ArticlePropertyDefinition tampered = snapshot.Definition with
        {
            DisplayNames = [new("en", "Changed")]
        };
        Assert.Contains(CreateVerifier().Verify(snapshot with
        {
            Definition = tampered
        }).Violations,
            static violation => violation.Code == "definition_tamper");
        Assert.Equal(renamed.AfterDefinitionDigest, snapshot.Definition.ContentDigest);
    }

    [Fact]
    public void Same_Count_Obligations_Bind_Every_Content_Field()
    {
        ArticlePropertyDefinitionObligation original = new("reconcile", 1, true, "existing");
        string digest = ArticlePropertyDefinitionContract.ComputeObligationsDigest([original]);
        ArticlePropertyDefinitionObligation[] changes =
        [
            original with { Kind = "archive" }, original with { AffectedValueCount = 2 },
            original with { RequiresReconciliation = false }, original with { ReasonCode = "different" }
        ];
        Assert.All(changes, change => Assert.NotEqual(digest, ArticlePropertyDefinitionContract.ComputeObligationsDigest([change])));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Update_Idempotency_Binds_Each_Presence_Setting(int setting)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "presence-" + setting);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        var command = UpdateCommandFor(definition, 1, 1) with
        {
            DefaultValue = new(ArticlePropertyDefaultKind.Scalar, "value")
        };
        await store.UpdateAsync(command);
        Assert.True((await store.UpdateAsync(command)).IsIdempotentReplay);
        ArticlePropertyPresencePolicy changed = setting switch
        {
            0 => command.Presence with { Missing = ArticlePropertyMissingBehavior.ApplyDefault },
            1 => command.Presence with { Null = ArticlePropertyNullBehavior.RejectNull },
            _ => command.Presence with { Empty = ArticlePropertyEmptyBehavior.RejectEmpty }
        };
        ArticlePropertyDefinitionConflictException conflict = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(
            () => store.UpdateAsync(command with { Presence = changed }));
        Assert.Equal("article_property_idempotency_conflict", conflict.Code);
        Assert.Equal(2, persistence.Receipts.Count);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Default_Union_Rejects_Foreign_Payload_Before_Normalization(int mutation)
    {
        Guid optionId = Guid.CreateVersion7();
        ArticlePropertyDefaultValue invalid = mutation switch
        {
            0 => new(ArticlePropertyDefaultKind.Scalar, "value", OptionIds: [optionId]),
            1 => new(ArticlePropertyDefaultKind.Scalar, "value", ArticleIds: [1]),
            2 => new(ArticlePropertyDefaultKind.OptionIds, "value", [optionId]),
            3 => new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId], ArticleIds: [1]),
            4 => new(ArticlePropertyDefaultKind.ArticleIds, "value", ArticleIds: [1]),
            5 => new(ArticlePropertyDefaultKind.ArticleIds, OptionIds: [optionId], ArticleIds: [1]),
            6 => new(ArticlePropertyDefaultKind.None, "value"),
            7 => new(ArticlePropertyDefaultKind.Null, OptionIds: [optionId]),
            _ => new((ArticlePropertyDefaultKind)99)
        };
        ArticlePropertyValueType type = invalid.Kind switch
        {
            ArticlePropertyDefaultKind.OptionIds => ArticlePropertyValueType.SingleSelect,
            ArticlePropertyDefaultKind.ArticleIds => ArticlePropertyValueType.ArticleReference,
            _ => ArticlePropertyValueType.Text
        };
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "union-" + mutation);
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, type, 0, 0);
        ArticlePropertyDefinitionValidationException createError = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => store.CreateAsync(create with { DefaultValue = invalid }));
        Assert.Equal("article_property_default_invalid", createError.Code);
        Assert.Empty(persistence.Receipts);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(create);
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        ArticlePropertyDefinitionValidationException updateError = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => store.UpdateAsync(UpdateCommandFor(definition, 1, 1) with { DefaultValue = invalid }));
        Assert.Equal("article_property_default_invalid", updateError.Code);
        Assert.Single(persistence.Receipts);
    }

    [Theory]
    [InlineData(ArticlePropertyEmptyBehavior.PreserveEmpty, ArticlePropertyNullBehavior.AllowNull, true)]
    [InlineData(ArticlePropertyEmptyBehavior.PreserveEmpty, ArticlePropertyNullBehavior.RejectNull, true)]
    [InlineData(ArticlePropertyEmptyBehavior.RejectEmpty, ArticlePropertyNullBehavior.AllowNull, false)]
    [InlineData(ArticlePropertyEmptyBehavior.RejectEmpty, ArticlePropertyNullBehavior.RejectNull, false)]
    [InlineData(ArticlePropertyEmptyBehavior.TreatAsNull, ArticlePropertyNullBehavior.AllowNull, true)]
    [InlineData(ArticlePropertyEmptyBehavior.TreatAsNull, ArticlePropertyNullBehavior.RejectNull, false)]
    public async Task Empty_Default_Obeys_Presence_Policy(ArticlePropertyEmptyBehavior empty, ArticlePropertyNullBehavior nullBehavior, bool accepted)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "empty-default");
        var command = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0) with
        {
            DefaultValue = new(ArticlePropertyDefaultKind.Scalar, string.Empty),
            Presence = new(ArticlePropertyMissingBehavior.ApplyDefault, nullBehavior, empty)
        };
        if (accepted)
        {
            ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(command);
            Assert.Equal(string.Empty, (await store.GetAsync(s_actor, owner, created.DefinitionId))!.DefaultValue!.Scalar);
        }
        else
        {
            ArticlePropertyDefinitionValidationException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
                () => store.CreateAsync(command));
            Assert.Equal("article_property_default_empty_invalid", error.Code);
            Assert.Empty(persistence.Receipts);
        }
    }

    [Theory]
    [InlineData(0, "definition_digest_chain_mismatch")]
    [InlineData(1, "latest_receipt_facts_mismatch")]
    [InlineData(2, "latest_receipt_facts_mismatch")]
    [InlineData(3, "latest_receipt_facts_mismatch")]
    [InlineData(4, "latest_receipt_facts_mismatch")]
    [InlineData(5, "audit_digest_mismatch")]
    [InlineData(6, "receipt_tamper")]
    [InlineData(7, "audit_digest_mismatch")]
    public async Task Verifier_Rejects_Receipt_Fact_Chain_Audit_And_Obligation_Tamper(int mutation, string code)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "tamper-" + mutation);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        await store.UpdateAsync(UpdateCommandFor(definition, 1, 1));
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        ArticlePropertyDefinitionVerifier verifier = CreateVerifier();
        Assert.True(verifier.Verify(snapshot).Valid);
        string different = new('a', 64);
        ArticlePropertyDefinitionWriteReceipt latest = snapshot.Receipts[^1];
        ArticlePropertyDefinitionWriteReceipt changed = mutation switch
        {
            0 => latest with { BeforeDefinitionDigest = different },
            1 => latest with { ConstraintDigest = different },
            2 => latest with { OptionsDigest = different },
            3 => latest with { PolicyDigest = different },
            4 => latest with { FlagsDigest = different },
            5 => latest with { AfterDefinitionDigest = different },
            _ => latest with { Obligations = [latest.Obligations[0] with { RequiresReconciliation = false }] }
        };
        // A public receipt hash is not an independent authority. Only case six leaves
        // that hash unchanged; the existing signed audit links and definition stay fixed.
        if (mutation != 6)
        {
            changed = changed with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeReceiptDigest(changed)
            };
        }
        if (mutation == 7)
        {
            ArticlePropertyDefinitionWriteReceipt forged = changed with
            {
                AuditDigest = ArticlePropertyDefinitionContract.ComputeReceiptAuditDigest(changed)
            };
            forged = forged with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeReceiptDigest(forged)
            };
            Assert.Contains(verifier.Verify(snapshot with
            {
                Receipts = [snapshot.Receipts[0], forged]
            }).Violations,
                static violation => violation.Code == "audit_link_tamper");
        }
        Assert.Contains(verifier.Verify(snapshot with
        {
            Receipts = [snapshot.Receipts[0], changed]
        }).Violations,
            violation => violation.Code == code);
    }

    [Fact]
    public async Task Verifier_Rejects_Foreign_And_Duplicate_Receipts_Without_Throwing()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "receipt-scope");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        ArticlePropertyDefinitionVerifier verifier = CreateVerifier();
        Assert.Contains(verifier.Verify(snapshot with
        {
            Receipts = [created, created]
        }).Violations,
            static violation => violation.Code == "receipt_duplicate");
        Assert.Contains(verifier.Verify(snapshot with
        {
            Receipts = [created with { DefinitionId = Guid.CreateVersion7() }]
        }).Violations,
            static violation => violation.Code == "receipt_scope_mismatch");
    }

    [Fact]
    public async Task Verifier_Accepts_Actor_Scoped_Request_Ids_And_Rejects_Bad_Origin_Or_Audit_Link()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.Site("actor-request");
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(create);
        var otherActor = new ArticlePropertyDefinitionActor(43, [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig]);
        await store.RenameAsync(new(otherActor, owner, created.DefinitionId, create.RequestId, 1, 1, [new("en", "Other actor label")]));
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        ArticlePropertyDefinitionVerifier verifier = CreateVerifier();
        Assert.True(verifier.Verify(snapshot).Valid);
        var badOrigin = created with
        {
            BeforeDefinitionDigest = new string('b', 64)
        };
        badOrigin = badOrigin with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeReceiptDigest(badOrigin)
        };
        Assert.Contains(verifier.Verify(snapshot with
        {
            Receipts = [badOrigin, snapshot.Receipts[1]]
        }).Violations,
            static violation => violation.Code == "schema_revision_origin_invalid");
        Assert.Contains(verifier.Verify(snapshot with
        {
            AuditLinks = [snapshot.AuditLinks[0] with { Outcome = "denied" }, snapshot.AuditLinks[1]]
        }).Violations, static violation => violation.Code == "audit_link_tamper");
    }

    [Fact]
    public async Task Two_Device_Schema_Edits_Have_One_Winner_And_Stale_Schema_Is_Rejected()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "two-devices");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        UpdateArticlePropertyDefinitionCommand left = UpdateCommandFor(definition, 1, 1, true);
        UpdateArticlePropertyDefinitionCommand right = UpdateCommandFor(definition, 1, 1);
        Task<ArticlePropertyDefinitionWriteReceipt>[] tasks = [store.UpdateAsync(left), store.UpdateAsync(right)];
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => Task.WhenAll(tasks));
        Assert.Single(tasks, static task => task.IsCompletedSuccessfully);
        Assert.Single(tasks, static task => task.IsFaulted);
        Assert.Equal(2, persistence.Receipts.Count);
        ArticlePropertyDefinitionConflictException stale = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(
            () => store.UpdateAsync(UpdateCommandFor(definition, 2, 1)));
        Assert.Equal("article_property_schema_revision_cas_stale", stale.Code);
    }

    [Fact]
    public async Task Live_1000_Pagination_And_Overflow_Are_Bounded_While_Tombstone_Identity_Survives()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "live-budget");
        Assert.Empty((await store.ListAsync(s_actor, owner, null, 100)).Items);
        CreateArticlePropertyDefinitionCommand first = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(first);
        Assert.Single((await store.ListAsync(s_actor, owner, null, 100)).Items);
        for (int index = 1; index < 1_000; index++)
        {
            await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, index, index));
        }
        await Assert.ThrowsAsync<ArticlePropertyDefinitionBudgetExceededException>(
            () => store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 1_000, 1_000)));
        var ids = new HashSet<Guid>();
        ArticlePropertyDefinitionPageCursor? cursor = null;
        int pages = 0;
        do
        {
            ArticlePropertyDefinitionPage page = await store.ListAsync(s_actor, owner, cursor, 100);
            Assert.InRange(page.Items.Count, 1, 100);
            Assert.Equal(1_000, page.OwnerRevision);
            Assert.All(page.Items, item => Assert.True(ids.Add(item.DefinitionId)));
            cursor = page.NextCursor;
            pages++;
        } while (cursor is not null);
        Assert.Equal(10, pages);
        Assert.Equal(1_000, ids.Count);
        // Full owner replay, not a sample or a truncated per-definition prefix.
        ArticlePropertyDefinitionVerificationSnapshot dense = (await persistence.ReadVerificationSnapshotAsync(
            owner, created.DefinitionId, ArticlePropertyDefinitionContract.MaxVerificationReceipts))!;
        Assert.Equal(1_000, dense.Replay!.Definitions.Count);
        Assert.Equal(1_000, dense.Replay.Entries.Count);
        Assert.True(CreateVerifier().Verify(dense).Valid);
        await store.DeprecateAsync(new(s_actor, owner, created.DefinitionId, Guid.CreateVersion7(), 1_000, 1));
        await store.DeleteAsync(new(s_actor, owner, created.DefinitionId, Guid.CreateVersion7(), 1_001, 2));
        await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 1_000, 1_002));
        Assert.Null(await store.GetAsync(s_actor, owner, created.DefinitionId));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.CreateAsync(
            first with
            {
                RequestId = Guid.CreateVersion7(),
                ExpectedOwnerRevision = 1_003
            }));
        Assert.Equal(1_000, persistence.MaximumLiveSnapshotCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public async Task Reference_Policy_Facts_And_Stable_Ids_Are_Digest_Bound(int setting)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "reference-policy-" + setting);
        CreateArticlePropertyDefinitionCommand command = CreateCommand(owner, ArticlePropertyValueType.ArticleReference, 0, 0);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(command);
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        ArticlePropertyReferencePolicy policy = snapshot.Definition.ReferencePolicy!;
        ArticlePropertyReferencePolicy changed = setting switch
        {
            0 => policy with { Permission = ArticlePropertyReferencePermission.SiteEditorMayReference },
            1 => policy with { AllowCrossSite = true },
            2 => policy with { AllowDeleted = true },
            3 => policy with { AllowArchived = true },
            4 => policy with { AllowSelfReference = true },
            _ => policy with { AllowCycles = true }
        };
        Assert.NotEqual(ArticlePropertyDefinitionContract.ComputePolicyDigest(policy, null),
            ArticlePropertyDefinitionContract.ComputePolicyDigest(changed, null));
        Assert.Contains(CreateVerifier().Verify(snapshot with
        {
            Definition = snapshot.Definition with
            {
                ReferencePolicy = changed
            }
        }).Violations, static violation => violation.Code == "definition_tamper");
        Assert.Equal(command.DefaultValue!.ArticleIds, snapshot.Definition.DefaultValue!.ArticleIds);
        // These are definition-only policy facts, not a fabricated read/permission
        // verdict about actual target articles owned by the later value authority.
    }

    [Fact]
    public async Task Reference_Ids_And_Policy_Enums_Reject_Invalid_Definition_Defaults()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "reference-invalid");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(owner, ArticlePropertyValueType.ArticleReference, 0, 0);
        foreach (long[] ids in new long[][] { [0], [-1], [1, 1] })
        {
            await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(command with
            {
                DefaultValue = new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: ids)
            }));
        }
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(command with
        {
            ReferencePolicy = command.ReferencePolicy! with
            {
                Permission = (ArticlePropertyReferencePermission)99
            }
        }));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(command with
        {
            ReferencePolicy = command.ReferencePolicy! with
            {
                Cardinality = ArticlePropertyCardinality.Single
            }
        }));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionBudgetExceededException>(() => store.CreateAsync(command with
        {
            DefaultValue = new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: Enumerable.Range(1, 1_001).Select(static id => (long)id).ToArray())
        }));
        Assert.Empty(persistence.Receipts);
    }

    [Fact]
    public async Task Default_Constraints_Options_Lifecycle_And_Unknown_Impact_Fail_Closed()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "constraint-impact");
        CreateArticlePropertyDefinitionCommand text = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(text with
        {
            DefaultValue = new(ArticlePropertyDefaultKind.Scalar, "too long"),
            Constraints = new(MaxLength: 1)
        }));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(text with { Constraints = new(MinNumber: 1) }));
        Guid optionId = Guid.CreateVersion7();
        CreateArticlePropertyDefinitionCommand select = CreateCommand(owner, ArticlePropertyValueType.SingleSelect, 0, 0,
            [new(optionId, "Option", 0, ArticlePropertyOptionStatus.Active)], new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId]));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(select with
        {
            Options = [select.Options[0] with { Status = ArticlePropertyOptionStatus.Deleted }]
        }));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(select with
        {
            Options = [select.Options[0], new(Guid.CreateVersion7(), "Duplicate order", 0, ArticlePropertyOptionStatus.Active)]
        }));
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(select);
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        Guid replacementId = Guid.CreateVersion7();
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.UpdateAsync(
            UpdateCommandFor(definition, 1, 1) with
            {
                Options = [new(replacementId, "Replacement", 0, ArticlePropertyOptionStatus.Active)],
                DefaultValue = new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [replacementId])
            }));
        var unavailableStore = new ArticlePropertyDefinitionStore(persistence, new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyDefinitionImpactAuthority(), CreateVerifier(), TimeProvider.System);
        ArticlePropertyDefinitionWriteReceipt deprecated = await unavailableStore.DeprecateAsync(
            new(s_actor, owner, created.DefinitionId, Guid.CreateVersion7(), 1, 1));
        Assert.Contains(deprecated.Obligations, static obligation => obligation.RequiresReconciliation && obligation.AffectedValueCount is null);
        ArticlePropertyDefinitionConflictException deletion = await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() =>
            unavailableStore.DeleteAsync(new(s_actor, owner, created.DefinitionId, Guid.CreateVersion7(), 2, 2)));
        Assert.Equal("article_property_delete_impact_unknown", deletion.Code);
        Assert.Equal(ArticlePropertyDefinitionStatus.Deprecated, (await store.GetAsync(s_actor, owner, created.DefinitionId))!.Status);
        Assert.Equal(2, persistence.Receipts.Count);
    }

    [Fact]
    public async Task Verifier_Returns_Invalid_For_Null_Receipt_Obligations_Without_Rehashing()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "null-receipt-obligations");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, created.DefinitionId, 100))!;
        ArticlePropertyDefinitionVerifier verifier = CreateVerifier();
        Assert.True(verifier.Verify(snapshot).Valid);
        ArticlePropertyDefinitionWriteReceipt malformed = snapshot.Receipts[0] with
        {
            Obligations = null!
        };
        Assert.Null(malformed.Obligations);
        ArticlePropertyDefinitionVerificationResult result = verifier.Verify(snapshot with
        {
            Receipts = [malformed]
        });
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "receipt_tamper"
            && violation.Detail.EndsWith(":article_property_receipt_obligations_invalid", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public async Task Recorded_Command_Codec_Round_Trips_Each_Real_Closed_Command(int tag)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "codec-" + tag);
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0);
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(create);
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, receipt.DefinitionId))!;
        ArticlePropertyDefinitionRecordedCommand command = tag switch
        {
            1 => ArticlePropertyDefinitionCommandHistory.Capture(create with { MachineKey = "  RAW_KEY  ", DisplayNames = [new("EN", " Raw Name ")] }),
            2 => ArticlePropertyDefinitionCommandHistory.Capture(UpdateCommandFor(definition, 1, 1)),
            3 => ArticlePropertyDefinitionCommandHistory.Capture(new RenameArticlePropertyDefinitionCommand(s_actor, owner, receipt.DefinitionId,
                Guid.CreateVersion7(), 1, 1, [new("ZH", " Raw Name "), new("EN", "Second")])),
            4 => ArticlePropertyDefinitionCommandHistory.Capture(new DeprecateArticlePropertyDefinitionCommand(s_actor, owner,
                receipt.DefinitionId, Guid.CreateVersion7(), 1, 1)),
            _ => ArticlePropertyDefinitionCommandHistory.Capture(new DeleteArticlePropertyDefinitionCommand(s_actor, owner,
                receipt.DefinitionId, Guid.CreateVersion7(), 1, 1))
        };
        byte[] bytes = ArticlePropertyDefinitionCommandHistory.Encode(command);
        Assert.Equal(tag, bytes[4]);
        ArticlePropertyDefinitionRecordedCommand decoded = ArticlePropertyDefinitionCommandHistory.Decode(bytes);
        Assert.Equal(bytes, ArticlePropertyDefinitionCommandHistory.Encode(decoded));
        Assert.Equal(command.RequestId, decoded.RequestId);
        Assert.Equal(command.ExpectedOwnerRevision, decoded.ExpectedOwnerRevision);
        if (tag == 1)
        {
            Assert.Equal("  RAW_KEY  ", decoded.Create!.MachineKey);
            Assert.Equal("EN", decoded.Create.DisplayNames[0].Locale);
        }
        if (tag == 3)
        {
            Assert.Equal("ZH", decoded.Rename!.DisplayNames[0].Locale);
            Assert.Equal(" Raw Name ", decoded.Rename.DisplayNames[0].Value);
        }
    }

    [Fact]
    public void Captured_Command_Has_Immutable_Permission_And_Collection_Facts()
    {
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "deep-copy");
        var names = new List<ArticlePropertyLocalizedName> { new("en", "Original") };
        var permissions = new HashSet<string> { AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig };
        var actor = new ArticlePropertyDefinitionActor(42, permissions);
        CreateArticlePropertyDefinitionCommand create = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0)
            with
        {
            Actor = actor,
            DisplayNames = names
        };
        ArticlePropertyDefinitionRecordedCommand captured = ArticlePropertyDefinitionCommandHistory.Capture(create);
        names[0] = new("en", "Changed");
        permissions.Clear();
        Assert.Equal("Original", captured.Create!.DisplayNames[0].Value);
        Assert.Contains(AdminPermissions.ArticleWrite, captured.Actor.Permissions);
        Assert.False(captured.Actor.Permissions is HashSet<string>);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public void Recorded_Command_Codec_Refuses_Malformed_Envelopes_Before_Allocation(int mutation)
    {
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "codec-refusal");
        byte[] bytes = ArticlePropertyDefinitionCommandHistory.Encode(
            ArticlePropertyDefinitionCommandHistory.Capture(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0)));
        byte[] changed = (byte[])bytes.Clone();
        switch (mutation)
        {
            case 0:
                changed[0] = 2;
                break;
            case 1:
                changed[4] = 255;
                break;
            case 2:
                changed = [.. bytes, 0];
                break;
            case 3:
                changed = bytes[..^1];
                break;
            case 4:
                Array.Fill(changed, (byte)255, 13, 4);
                break; // Negative permission count.
            case 5:
                BitConverter.GetBytes(int.MaxValue).CopyTo(changed, 13);
                break;
            case 6:
                changed = new byte[ArticlePropertyDefinitionCommandHistory.MaxCommandPayloadBytes + 1];
                break;
        }
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyDefinitionCommandHistory.Decode(changed));
    }

    [Fact]
    public async Task Recorded_Command_Preserves_Original_Actor_Raw_Permission_Padding()
    {
        string padded = new string(' ', 600) + "x";
        var actor = new ArticlePropertyDefinitionActor(42,
            [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig, padded]);
        ArticlePropertyDefinitionContract.ValidateActor(actor);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "raw-permission-padding");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0)
            with
        {
            Actor = actor
        };
        ArticlePropertyDefinitionRecordedCommand captured = ArticlePropertyDefinitionCommandHistory.Capture(command);
        byte[] payload = ArticlePropertyDefinitionCommandHistory.Encode(captured);
        Assert.InRange(payload.Length, 513, ArticlePropertyDefinitionCommandHistory.MaxCommandPayloadBytes);
        ArticlePropertyDefinitionRecordedCommand decoded = ArticlePropertyDefinitionCommandHistory.Decode(payload);
        Assert.Contains(padded, captured.Actor.Permissions);
        Assert.Contains(padded, decoded.Actor.Permissions);
        Assert.Equal(payload, ArticlePropertyDefinitionCommandHistory.Encode(decoded));
        Assert.False(decoded.Actor.Permissions is HashSet<string>);
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(command);
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, receipt.DefinitionId, 100))!;
        Assert.Contains(padded, snapshot.Replay!.Entries[0].Command.Actor.Permissions);
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void Verification_read_admission_refuses_malformed_link_or_foreign_target_receipt_before_hydration(
        bool invalidAuditLink,
        bool foreignReceipt)
    {
        long[] denseCounts = [1_000, 1_000, 1_000, 1_000, 1_000];
        Assert.True(PostgresArticlePropertyDefinitionPersistence.CanReadVerificationEvidence(
            10_000, denseCounts, 16 * 1_024 * 1_024, 1_000, false, false));
        // Exercise the production scalar admission decision without creating a
        // 64 MiB EventInfo or hydrating attacker-controlled obligation collections.
        Assert.False(PostgresArticlePropertyDefinitionPersistence.CanReadVerificationEvidence(
            10_000, denseCounts, 16 * 1_024 * 1_024, 1_000, invalidAuditLink, foreignReceipt));
        Assert.False(PostgresArticlePropertyDefinitionPersistence.CanReadVerificationEvidence(
            10_000, denseCounts, 4L * 64 * 1_024 * 1_024, 1_000, invalidAuditLink, foreignReceipt));
    }

    [Fact]
    public async Task Forward_Replay_Covers_All_Commands_Interleaved_Owner_Facts_And_Tombstones()
    {
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await BuildReplayFixture();
        Assert.Equal(6, snapshot.Replay!.OwnerRevision);
        Assert.Equal(6, snapshot.Replay.Entries.Count);
        Assert.Equal(2, snapshot.Replay.Definitions.Count);
        Assert.Equal(ArticlePropertyDefinitionStatus.Deleted, snapshot.Definition.Status);
        Assert.Equal(new[] { "create", "create", "change-settings", "rename", "deprecate", "delete" },
            snapshot.Replay.Entries.Select(static entry => entry.Command.CommandKind));
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Forward_Replay_Refuses_Legacy_And_Incomplete_Or_Reordered_Owner_History(int mutation)
    {
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await BuildReplayFixture();
        ArticlePropertyDefinitionReplaySnapshot replay = snapshot.Replay!;
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
        ArticlePropertyDefinitionReplaySnapshot? changed = mutation switch
        {
            0 => null,
            1 => replay with { HistoryVersion = 2 },
            2 => replay with { GenesisDigest = new string('a', 64) },
            3 => replay with { Entries = replay.Entries.Reverse().ToArray() },
            4 => replay with { Entries = replay.Entries.Skip(1).ToArray() },
            5 => replay with { Entries = [replay.Entries[0], replay.Entries[0], .. replay.Entries.Skip(2)] },
            6 => replay with { Definitions = replay.Definitions.Where(item => item.Status != ArticlePropertyDefinitionStatus.Deleted).ToArray() },
            7 => replay with { HistoryLimitExceeded = true },
            _ => replay with { ResourceLimitExceeded = true }
        };
        ArticlePropertyDefinitionVerificationResult result = CreateVerifier().Verify(snapshot with
        {
            Replay = changed
        });
        Assert.False(result.Valid);
        if (mutation == 0)
        {
            Assert.Contains(result.Violations, static violation => violation.Code == "history_unavailable");
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task Forward_Replay_Checks_Real_Mac_And_Daily_Previous_Record_Not_Public_Hash(int mutation)
    {
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await BuildReplayFixture();
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
        AuditLog[] rows = snapshot.Replay!.AuditRecords.Select(CloneAudit).ToArray();
        if (mutation == 0)
        {
            rows[0].RecordMac = null;
        }
        else if (mutation == 1)
        {
            rows[0].EventInfo += ":public-reseal";
            rows[0].RecordHash = AuditTamperEvidence.Sign(AuditTamperEvidence.FromLog(rows[0]), key: null).RecordHash;
            // Original MAC remains: a recomputed public hash is not a signature.
        }
        else if (mutation == 2)
        {
            rows[1].PrevHash = new string('b', 64);
        }
        else
        {
            rows = rows.Skip(1).ToArray();
        }
        ArticlePropertyDefinitionVerificationResult result = CreateVerifier().Verify(snapshot with
        {
            Replay = snapshot.Replay with
            {
                AuditRecords = rows
            }
        });
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "history_audit_mac_or_chain_invalid");
        Assert.False(new ArticlePropertyDefinitionVerifier().Verify(snapshot).Valid); // No configured MAC key.
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public async Task Independent_Replay_Rejects_Authenticated_Commands_That_Cannot_Produce_Receipts(int mutation)
    {
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await BuildReplayFixture();
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
        ArticlePropertyDefinitionJournalEntry[] entries = snapshot.Replay!.Entries.ToArray();
        int index = mutation == 4 ? 3 : mutation == 5 ? 5 : 2;
        ArticlePropertyDefinitionJournalEntry entry = entries[index];
        if (mutation == 5)
        {
            entry = entry with
            {
                Impact = entry.Impact with
                {
                    AffectedValueCount = null
                }
            };
        }
        else if (mutation == 4)
        {
            entry = entry with
            {
                Command = entry.Command with
                {
                    Rename = entry.Command.Rename! with
                    {
                        DisplayNames = [new("en", "Not the recorded result")]
                    }
                }
            };
        }
        else
        {
            UpdateArticlePropertyDefinitionCommand update = entry.Command.Update!;
            update = mutation switch
            {
                0 => update with { ExpectedOwnerRevision = 0 },
                1 => update with { ExpectedSchemaRevision = 99 },
                2 => update with { ValueType = ArticlePropertyValueType.Number },
                _ => update with { Presence = update.Presence with { Empty = ArticlePropertyEmptyBehavior.RejectEmpty } }
            };
            entry = entry with
            {
                Command = entry.Command with
                {
                    Update = update
                }
            };
        }
        entries[index] = entry;
        ArticlePropertyDefinitionVerificationSnapshot forged = ResealFixtureHistory(snapshot, entries);
        // A test key authenticates the altered fixture to isolate actual command replay.
        // Production never creates or repairs history from these fixture helpers.
        Assert.False(CreateVerifier().Verify(forged).Valid);
        Assert.Contains(CreateVerifier().Verify(forged).Violations,
            static violation => violation.Code == "history_replay_invalid");
    }

    [Fact]
    public async Task Verification_Resource_Admission_Refuses_Aggregate_Payload_Without_Partial_Pass()
    {
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await BuildReplayFixture();
        Assert.True(CreateVerifier().Verify(snapshot).Valid);
        AuditLog[] rows = snapshot.Replay!.AuditRecords.Select(CloneAudit).ToArray();
        rows[0].ContextPayload = new byte[ArticlePropertyDefinitionContract.MaxVerificationResourceBytes / 2];
        ArticlePropertyDefinitionVerificationResult result = CreateVerifier().Verify(snapshot with
        {
            Replay = snapshot.Replay with
            {
                AuditRecords = rows
            }
        });
        Assert.False(result.Valid);
        Assert.Contains(result.Violations, static violation => violation.Code == "verification_resource_budget_exceeded");
        var persistence = new MemoryPersistence { RefuseVerificationResourceAdmission = true };
        persistence.RefuseVerificationResourceAdmission = false;
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "resource-port-refusal");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        persistence.RefuseVerificationResourceAdmission = true;
        ArticlePropertyDefinitionVerificationResult refused = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
        Assert.False(refused.Valid);
        Assert.Contains(refused.Violations, static violation => violation.Code == "verification_resource_budget_exceeded");
    }

    private static async Task<ArticlePropertyDefinitionVerificationSnapshot> BuildReplayFixture()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "full-forward-replay");
        ArticlePropertyDefinitionWriteReceipt first = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Boolean, 1, 1));
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, first.DefinitionId))!;
        await store.UpdateAsync(UpdateCommandFor(definition, 2, 1, true));
        await store.RenameAsync(new(s_actor, owner, first.DefinitionId, Guid.CreateVersion7(), 3, 2, [new("en", "Renamed")]));
        await store.DeprecateAsync(new(s_actor, owner, first.DefinitionId, Guid.CreateVersion7(), 4, 3));
        await store.DeleteAsync(new(s_actor, owner, first.DefinitionId, Guid.CreateVersion7(), 5, 4));
        return (await persistence.ReadVerificationSnapshotAsync(owner, first.DefinitionId, 100))!;
    }

    private static ArticlePropertyDefinitionVerificationSnapshot ResealFixtureHistory(
        ArticlePropertyDefinitionVerificationSnapshot snapshot,
        ArticlePropertyDefinitionJournalEntry[] entries)
    {
        string previous = snapshot.Replay!.GenesisDigest;
        for (int index = 0; index < entries.Length; index++)
        {
            entries[index] = entries[index] with
            {
                PreviousDigest = previous
            };
            entries[index] = entries[index] with
            {
                ContentDigest = ArticlePropertyDefinitionCommandHistory.ComputeEntryDigest(entries[index])
            };
            previous = entries[index].ContentDigest;
        }
        AuditLog[] rows = snapshot.Replay.AuditRecords.Select(CloneAudit).ToArray();
        var tails = new Dictionary<string, string>();
        foreach (AuditLog row in rows.OrderBy(static row => row.Id))
        {
            ArticlePropertyDefinitionJournalEntry? entry = entries.FirstOrDefault(item => item.Receipt.AuditReference.ToString("N") == row.TargetId);
            if (entry is not null)
            {
                row.EventInfo = ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry);
            }
            row.PrevHash = tails.GetValueOrDefault(row.ChainId!);
            AuditTamperEvidenceResult signed = AuditTamperEvidence.Sign(AuditTamperEvidence.FromLog(row), s_auditKey);
            row.RecordHash = signed.RecordHash;
            row.RecordMac = signed.RecordMac;
            tails[row.ChainId!] = signed.RecordHash;
        }
        ArticlePropertyDefinitionAuditLink[] links = snapshot.AuditLinks.Select(link => link with
        {
            EventInfo = ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entries.Single(entry => entry.Receipt.AuditReference == link.AuditReference))
        }).ToArray();
        return snapshot with
        {
            AuditLinks = links,
            Replay = snapshot.Replay with
            {
                Entries = entries,
                HeadDigest = previous,
                AuditRecords = rows
            }
        };
    }

    private static AuditLog CloneAudit(AuditLog row)
        => new()
        {
            Id = row.Id,
            Source = row.Source,
            Type = row.Type,
            OccurredAtUtc = row.OccurredAtUtc,
            ActorType = row.ActorType,
            ActorId = row.ActorId,
            ActorRole = row.ActorRole,
            Action = row.Action,
            TargetType = row.TargetType,
            TargetId = row.TargetId,
            Outcome = row.Outcome,
            Severity = row.Severity,
            IsHighValue = row.IsHighValue,
            TraceId = row.TraceId,
            RequestPath = row.RequestPath,
            RequestMethod = row.RequestMethod,
            IpHash = row.IpHash,
            UserAgentHash = row.UserAgentHash,
            SessionIdHash = row.SessionIdHash,
            DeviceFingerprintHash = row.DeviceFingerprintHash,
            ReasonCode = row.ReasonCode,
            EventInfo = row.EventInfo,
            ContextJson = row.ContextJson,
            ContextPayload = row.ContextPayload is null ? null : (byte[])row.ContextPayload.Clone(),
            ChainId = row.ChainId,
            PrevHash = row.PrevHash,
            RecordHash = row.RecordHash,
            RecordMac = row.RecordMac
        };

    [Theory]
    [InlineData("number", "0.0000000000000000001")]
    [InlineData("number", "0.1234567890123456789012345670")]
    [InlineData("number", "79228162514264337593543950335")]
    [InlineData("number", "-79228162514264337593543950335")]
    [InlineData("date", "0")]
    [InlineData("date", "638962848000000001")]
    [InlineData("date", "3155378975999999999")]
    public async Task Persistence_constraint_reader_preserves_full_decimal_and_utc_tick_domain(
        string type,
        string value)
    {
        bool number = type == "number";
        decimal? expectedNumber = number ? decimal.Parse(value, CultureInfo.InvariantCulture) : null;
        DateTime? expectedDate = number
            ? null
            : new DateTime(long.Parse(value, CultureInfo.InvariantCulture), DateTimeKind.Utc);
        using var table = new DataTable();
        table.Columns.Add("constraint_value", number ? typeof(decimal) : typeof(long));
        table.Rows.Add((object?)expectedNumber ?? expectedDate!.Value.Ticks);
        table.Rows.Add(DBNull.Value);
        using DataTableReader reader = table.CreateDataReader();
        Assert.True(reader.Read());
        var constraints = new ArticlePropertyConstraints(
            MinNumber: number
                ? PostgresArticlePropertyDefinitionPersistence.ReadNullableDecimal(reader, "constraint_value")
                : null,
            MaxNumber: expectedNumber,
            MinDateUtc: number
                ? null
                : PostgresArticlePropertyDefinitionPersistence.ReadNullableUtcConstraintTicks(reader, "constraint_value"),
            MaxDateUtc: expectedDate);
        Assert.Equal(expectedNumber, constraints.MinNumber);
        if (number)
        {
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(constraints.MinNumber!.Value));
        }
        Assert.Equal(expectedDate?.Ticks, constraints.MinDateUtc?.Ticks);
        if (!number)
        {
            Assert.Equal(DateTimeKind.Utc, constraints.MinDateUtc!.Value.Kind);
        }
        Assert.True(reader.Read());
        Assert.Null(PostgresArticlePropertyDefinitionPersistence.ReadNullableDecimal(reader, "constraint_value"));
        Assert.Null(PostgresArticlePropertyDefinitionPersistence.ReadNullableUtcConstraintTicks(reader, "constraint_value"));

        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "constraint-reader-domain");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(
            owner, number ? ArticlePropertyValueType.Number : ArticlePropertyValueType.Date, 0, 0)
            with
        {
            Constraints = constraints,
            DefaultValue = null,
            Presence = new(
                    ArticlePropertyMissingBehavior.PreserveMissing,
                    ArticlePropertyNullBehavior.AllowNull,
                    ArticlePropertyEmptyBehavior.PreserveEmpty)
        };
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(command);
        ArticlePropertyDefinition actual = await store.GetAsync(s_actor, owner, receipt.DefinitionId)
            ?? throw new InvalidOperationException("constraint definition was not returned");
        Assert.Equal(constraints, actual.Constraints);
        Assert.Equal(ArticlePropertyDefinitionContract.ComputeConstraintDigest(constraints), receipt.ConstraintDigest);
        Assert.Equal(receipt.AfterDefinitionDigest, actual.ContentDigest);
        ArticlePropertyDefinitionVerificationResult verified = await store.VerifyAsync(s_actor, owner, receipt.DefinitionId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static violation => violation.Code)));
    }

    [Theory]
    [InlineData("change-settings")]
    [InlineData("rename")]
    [InlineData("deprecate")]
    [InlineData("delete")]
    public async Task Management_Idempotent_Replay_Rejects_Revoked_System_Config(string kind)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.Site("revoked-replay-" + kind);
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0));
        long previousRevision = 1;
        if (kind == "delete")
        {
            await store.DeprecateAsync(new(s_actor, owner, created.DefinitionId, Guid.CreateVersion7(), 1, 1));
            previousRevision = 2;
        }
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        Guid requestId = Guid.CreateVersion7();
        var revoked = new ArticlePropertyDefinitionActor(s_actor.AdminPrincipalId, [AdminPermissions.ArticleWrite]);
        Task<ArticlePropertyDefinitionWriteReceipt> Execute(ArticlePropertyDefinitionActor actor)
            => kind switch
            {
                "change-settings" => store.UpdateAsync(UpdateCommandFor(definition, previousRevision, previousRevision) with { Actor = actor, RequestId = requestId }),
                "rename" => store.RenameAsync(new(actor, owner, definition.DefinitionId, requestId, previousRevision, previousRevision, [new("en", "Renamed")])),
                "deprecate" => store.DeprecateAsync(new(actor, owner, definition.DefinitionId, requestId, previousRevision, previousRevision)),
                _ => store.DeleteAsync(new(actor, owner, definition.DefinitionId, requestId, previousRevision, previousRevision))
            };

        ArticlePropertyDefinitionWriteReceipt applied = await Execute(s_actor);
        Assert.True((await Execute(s_actor)).IsIdempotentReplay);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => Execute(revoked));
        Assert.Equal(previousRevision + 1, persistence.Receipts.Count);
        Assert.Equal(applied.ReceiptId, persistence.Receipts[^1].ReceiptId);
        Assert.Equal(previousRevision + 1, (await store.ListAsync(revoked, owner, null, 100)).OwnerRevision);
    }

    [Theory]
    [InlineData("0.00001")]
    [InlineData("-0.00001")]
    [InlineData("0.0000000000000000000000000001")]
    [InlineData("-0.0000000000000000000000000001")]
    public async Task Decimal_Canonical_Default_Round_Trips_Without_Exponent(string raw)
    {
        string normalized = ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Number, raw);
        Assert.DoesNotContain('E', normalized);
        Assert.Equal(normalized, ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Number, normalized));
        Assert.Equal(decimal.Parse(raw, CultureInfo.InvariantCulture), decimal.Parse(normalized, CultureInfo.InvariantCulture));
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "decimal-round-trip");
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Number, 0, 0,
            defaultValue: new(ArticlePropertyDefaultKind.Scalar, raw)));
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, receipt.DefinitionId))!;
        Assert.Equal(normalized, definition.DefaultValue!.Scalar);
        Assert.True((await store.VerifyAsync(s_actor, owner, receipt.DefinitionId)).Valid);
        Assert.True((await store.UpdateAsync(UpdateCommandFor(definition, 1, 1))).OwnerRevision == 2);
    }

    [Fact]
    public async Task None_Default_Normalizes_To_Absent_And_Preserves_Raw_Command()
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "none-default-round-trip");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(owner, ArticlePropertyValueType.Text, 0, 0,
            defaultValue: new(ArticlePropertyDefaultKind.None)) with
        {
            Presence = new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty)
        };
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(command);
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, receipt.DefinitionId))!;
        Assert.Null(definition.DefaultValue);
        var parameters = DefinitionParameters(definition);
        Assert.Equal((short)ArticlePropertyDefaultKind.None, parameters["@DefaultKind"]);
        ArticlePropertyDefaultValue? hydrated = ReadStoredDefault(parameters);
        Assert.Null(hydrated);
        ArticlePropertyDefinition rehydrated = definition with
        {
            DefaultValue = hydrated
        };
        Assert.Equal(definition.ContentDigest, ArticlePropertyDefinitionContract.ComputeDefinitionDigest(rehydrated));
        ArticlePropertyDefinitionContract.ValidateDefinition(rehydrated);
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, receipt.DefinitionId, 10_000))!;
        Assert.Equal(ArticlePropertyDefaultKind.None, snapshot.Replay!.Entries[0].Command.Create!.DefaultValue!.Kind);
        Assert.True((await store.VerifyAsync(s_actor, owner, receipt.DefinitionId)).Valid);
        Assert.True((await store.CreateAsync(command)).IsIdempotentReplay);
        await store.UpdateAsync(UpdateCommandFor(definition, 1, 1) with
        {
            DefaultValue = new(ArticlePropertyDefaultKind.None)
        });
        Assert.Null((await store.GetAsync(s_actor, owner, receipt.DefinitionId))!.DefaultValue);
        Assert.True((await store.VerifyAsync(s_actor, owner, receipt.DefinitionId)).Valid);
    }

    [Theory]
    [InlineData(886)]
    [InlineData(1000)]
    public async Task Option_Default_Storage_Capacity_Preserves_Complete_Accepted_Ids(int count)
    {
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "option-capacity-" + count);
        ArticlePropertyOption[] options = Enumerable.Range(0, count)
            .Select(index => new ArticlePropertyOption(Guid.CreateVersion7(), "Option " + index, index, ArticlePropertyOptionStatus.Active))
            .ToArray();
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(CreateCommand(owner, ArticlePropertyValueType.MultiSelect, 0, 0,
            options, new(ArticlePropertyDefaultKind.OptionIds, OptionIds: options.Select(static option => option.OptionId).ToArray())) with
        {
            Constraints = new(MinItems: 0, MaxItems: ArticlePropertyDefinitionContract.MaxOptionsPerDefinition)
        });
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, receipt.DefinitionId))!;
        var parameters = DefinitionParameters(definition);
        string serialized = Assert.IsType<string>(parameters["@DefaultOptionIds"]);
        Assert.Equal(count * 37 - 1, serialized.Length);
        Assert.Equal(string.Join(',', definition.DefaultValue!.OptionIds.Select(static id => id.ToString("D"))), serialized);
        ArticlePropertyDefaultValue hydrated = Assert.IsType<ArticlePropertyDefaultValue>(ReadStoredDefault(parameters));
        Assert.Equal<Guid>(definition.DefaultValue.OptionIds, hydrated.OptionIds);
        Assert.Equal(count, hydrated.OptionIds.Count);
        Assert.Equal(definition.ContentDigest, ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition with
        {
            DefaultValue = hydrated
        }));
        string[] owners = ["src/migration/Definitions/ArticlePropertyDefinitionAuthorityMigrationDefinitions.cs",
            "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs"];
        Assert.All(owners, path =>
        {
            string source = BackendTestPaths.ReadAllTextFromRoot(path);
            var match = System.Text.RegularExpressions.Regex.Match(source, @"default_option_ids varchar\((\d+)\)");
            Assert.True(match.Success, path);
            int capacity = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            Assert.True(capacity >= serialized.Length, $"{path}: {capacity} < {serialized.Length}");
        });
        Assert.True((await store.VerifyAsync(s_actor, owner, receipt.DefinitionId)).Valid);
    }

    [Theory]
    [InlineData("2024-01-01", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("2024-01-01T12:34:56", "2024-01-01T12:34:56.0000000Z")]
    [InlineData("2024-01-01T12:34:56+08:00", "2024-01-01T04:34:56.0000000Z")]
    [InlineData("2024-01-01T12:34:56Z", "2024-01-01T12:34:56.0000000Z")]
    [InlineData("2024-01", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("January 2024", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("January2024", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("2024Jan1", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("01/02/2024", "2024-01-02T00:00:00.0000000Z")]
    [InlineData("June 1, 2024", "2024-06-01T00:00:00.0000000Z")]
    [InlineData("01/02/24", "2024-01-02T00:00:00.0000000Z")]
    [InlineData("1 Jun 24", "2024-06-01T00:00:00.0000000Z")]
    [InlineData("01-2024", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("2024 Jan 1", "2024-01-01T00:00:00.0000000Z")]
    [InlineData("Mon, 01 Jan 2024 12:34:56 GMT", "2024-01-01T12:34:56.0000000Z")]
    [InlineData("12:34:56 2024-01-01", "2024-01-01T12:34:56.0000000Z")]
    public async Task Date_Default_Uses_Utc_And_Retains_Original_Complete_Calendar(string raw, string expected)
    {
        Assert.Equal(expected, ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Date, raw));
        Assert.Equal(expected, ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Date, expected));
        var persistence = new MemoryPersistence();
        ArticlePropertyDefinitionStore store = CreateStore(persistence);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "date-default-round-trip");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(owner, ArticlePropertyValueType.Date, 0, 0,
            defaultValue: new(ArticlePropertyDefaultKind.Scalar, raw));
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(command);
        ArticlePropertyDefinition definition = (await store.GetAsync(s_actor, owner, receipt.DefinitionId))!;
        Assert.Equal(expected, definition.DefaultValue!.Scalar);
        ArticlePropertyDefinitionVerificationSnapshot snapshot = (await persistence.ReadVerificationSnapshotAsync(owner, receipt.DefinitionId, 10_000))!;
        Assert.Equal(raw, snapshot.Replay!.Entries[0].Command.Create!.DefaultValue!.Scalar);
        Assert.True((await store.VerifyAsync(s_actor, owner, receipt.DefinitionId)).Valid);
    }

    [Theory]
    [InlineData("12:34:56")]
    [InlineData("12:34:56.2026")]
    [InlineData("12:34:56.2026-01")]
    [InlineData("12:34:56.20260101")]
    [InlineData("12:34:56.2026 01/02")]
    [InlineData("12:34:56+08:00")]
    [InlineData("01/02")]
    [InlineData("June 1")]
    [InlineData("January 24")]
    public void Date_Default_Refuses_Implicit_Current_Calendar_And_Fractional_Year(string raw)
    {
        ArticlePropertyDefinitionValidationException exception = Assert.Throws<ArticlePropertyDefinitionValidationException>(
            () => ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Date, raw));
        Assert.Equal("article_property_scalar_type_mismatch", exception.Code);
    }

    [Theory]
    [InlineData("1E-28")]
    [InlineData("NaN")]
    [InlineData("Infinity")]
    public void Decimal_Canonicalization_Preserves_Original_Input_Rejections(string raw)
    {
        ArticlePropertyDefinitionValidationException exception = Assert.Throws<ArticlePropertyDefinitionValidationException>(
            () => ArticlePropertyDefinitionContract.NormalizeScalar(ArticlePropertyValueType.Number, raw));
        Assert.Equal("article_property_scalar_type_mismatch", exception.Code);
    }

    private static Dictionary<string, object?> DefinitionParameters(ArticlePropertyDefinition definition)
    {
        var method = typeof(PostgresArticlePropertyDefinitionPersistence).GetMethod("DefinitionWriteParameters",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        var parameters = (SqlSugar.SugarParameter[])method.Invoke(null, [definition])!;
        return parameters.ToDictionary(static parameter => parameter.ParameterName, static parameter => (object?)parameter.Value);
    }

    private static ArticlePropertyDefaultValue? ReadStoredDefault(Dictionary<string, object?> parameters)
    {
        Type owner = typeof(PostgresArticlePropertyDefinitionPersistence);
        Type rowType = owner.GetNestedType("DefinitionRow", System.Reflection.BindingFlags.NonPublic)!;
        object row = Activator.CreateInstance(rowType, nonPublic: true)!;
        rowType.GetProperty("DefaultKind")!.SetValue(row, (ArticlePropertyDefaultKind)(short)parameters["@DefaultKind"]!);
        rowType.GetProperty("DefaultScalar")!.SetValue(row, parameters["@DefaultScalar"] is DBNull ? null : parameters["@DefaultScalar"]);
        rowType.GetProperty("DefaultOptionIds")!.SetValue(row, parameters["@DefaultOptionIds"]);
        rowType.GetProperty("DefaultArticleIds")!.SetValue(row, parameters["@DefaultArticleIds"]);
        return (ArticlePropertyDefaultValue?)owner.GetMethod("ReadDefault",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!.Invoke(null, [row]);
    }

    private static ArticlePropertyDefinitionStore CreateStore(MemoryPersistence persistence)
        => new(
            persistence,
            new ArticlePropertyDefinitionPermissionAuthority(),
            new KnownImpactAuthority(),
            CreateVerifier(),
            TimeProvider.System);

    private static CreateArticlePropertyDefinitionCommand CreateCommand(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyValueType valueType,
        int index,
        long expectedOwnerRevision,
        IReadOnlyList<ArticlePropertyOption>? options = null,
        ArticlePropertyDefaultValue? defaultValue = null)
    {
        ArticlePropertyCardinality cardinality = valueType is ArticlePropertyValueType.MultiSelect
            or ArticlePropertyValueType.ArticleReference
            ? ArticlePropertyCardinality.Multiple
            : ArticlePropertyCardinality.Single;
        options ??= [];
        if (valueType == ArticlePropertyValueType.SingleSelect && options.Count == 0)
        {
            Guid optionId = Guid.CreateVersion7();
            options = [new(optionId, "Default", 0, ArticlePropertyOptionStatus.Active)];
            defaultValue ??= new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId]);
        }
        if (valueType == ArticlePropertyValueType.MultiSelect && options.Count == 0)
        {
            Guid first = Guid.CreateVersion7();
            Guid second = Guid.CreateVersion7();
            options = [
                new(first, "First", 0, ArticlePropertyOptionStatus.Active),
                new(second, "Second", 1, ArticlePropertyOptionStatus.Active)
            ];
            defaultValue ??= new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [first, second]);
        }
        if (valueType == ArticlePropertyValueType.Number)
        {
            defaultValue ??= new(ArticlePropertyDefaultKind.Scalar, "1.5");
        }
        else if (valueType == ArticlePropertyValueType.Boolean)
        {
            defaultValue ??= new(ArticlePropertyDefaultKind.Scalar, "true");
        }
        else if (valueType == ArticlePropertyValueType.Date)
        {
            defaultValue ??= new(ArticlePropertyDefaultKind.Scalar, "2024-01-01T00:00:00.0000000Z");
        }
        else if (valueType == ArticlePropertyValueType.ArticleReference)
        {
            defaultValue ??= new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: [100 + index]);
        }
        else if (valueType == ArticlePropertyValueType.Url)
        {
            defaultValue ??= new(ArticlePropertyDefaultKind.Scalar, "https://example.com/property");
        }

        ArticlePropertyPresencePolicy presence = defaultValue is null
            ? new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty)
            : new(ArticlePropertyMissingBehavior.ApplyDefault, ArticlePropertyNullBehavior.RejectNull, ArticlePropertyEmptyBehavior.PreserveEmpty);
        ArticlePropertyConstraints constraints = valueType switch
        {
            ArticlePropertyValueType.Text => new(MinLength: 0, MaxLength: 256),
            ArticlePropertyValueType.Number => new(MinNumber: -10, MaxNumber: 10),
            ArticlePropertyValueType.MultiSelect => new(MinItems: 0, MaxItems: 2),
            ArticlePropertyValueType.ArticleReference => new(MinItems: 0, MaxItems: 1),
            _ => new()
        };
        ArticlePropertyReferencePolicy? referencePolicy = valueType == ArticlePropertyValueType.ArticleReference
            ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false)
            : null;
        ArticlePropertyUrlPolicy? urlPolicy = valueType == ArticlePropertyValueType.Url
            ? new(["https"], false, true, 2_048, ArticlePropertyUrlNormalization.LowerSchemeHost)
            : null;
        return new(
            s_actor,
            owner,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            expectedOwnerRevision,
            $"field-{valueType.ToString().ToLowerInvariant()}-{index}",
            [new ArticlePropertyLocalizedName("en", $"Property {index}")],
            valueType,
            cardinality,
            Required: false,
            presence,
            defaultValue,
            constraints,
            options,
            referencePolicy,
            urlPolicy,
            SearchEligible: false,
            Filterable: false,
            Sortable: false,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors);
    }

    private static UpdateArticlePropertyDefinitionCommand UpdateCommandFor(
        ArticlePropertyDefinition? definition,
        long ownerRevision,
        long schemaRevision,
        bool searchEligible = false)
    {
        ArgumentNullException.ThrowIfNull(definition);
        return new(
            s_actor,
            definition.Owner,
            definition.DefinitionId,
            Guid.CreateVersion7(),
            ownerRevision,
            schemaRevision,
            definition.ValueType,
            definition.Cardinality,
            definition.Required,
            definition.Presence,
            definition.DefaultValue,
            definition.Constraints,
            definition.Options,
            definition.ReferencePolicy,
            definition.UrlPolicy,
            searchEligible,
            definition.Filterable,
            definition.Sortable,
            definition.DisplayPlacement,
            definition.VisibilityScope);
    }

    private sealed class KnownImpactAuthority : IArticlePropertyDefinitionImpactAuthority
    {
        public Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
            ArticlePropertyDefinitionOwner owner,
            ArticlePropertyDefinition? before,
            ArticlePropertyDefinition after,
            string commandKind,
            CancellationToken cancellationToken = default)
            => Task.FromResult(
                new ArticlePropertyDefinitionImpact(
                    0,
                    before is null || commandKind == "rename"
                        ? []
                        : [new ArticlePropertyDefinitionObligation(
                            "article-property-definition-reconciliation",
                            0,
                            true,
                            "test_existing_value_reconciliation")]));
    }

    private sealed class MemoryPersistence : IArticlePropertyDefinitionPersistence
    {
        private readonly SemaphoreSlim _gate = new(1, 1);
        private readonly Dictionary<(ArticlePropertyDefinitionOwner Owner, Guid Id), ArticlePropertyDefinition> _definitions = [];
        private readonly Dictionary<ArticlePropertyDefinitionOwner, long> _revisions = [];
        private readonly Dictionary<(long Actor, Guid Request), (string Digest, ArticlePropertyDefinitionWriteReceipt Receipt)> _idempotency = [];
        private readonly List<ArticlePropertyDefinitionWriteReceipt> _receipts = [];
        private readonly List<ArticlePropertyDefinitionAuditLink> _auditLinks = [];
        private readonly List<ArticlePropertyDefinitionJournalEntry> _entries = [];
        private readonly List<AuditLog> _auditRecords = [];
        private readonly Dictionary<ArticlePropertyDefinitionOwner, string> _historyHeads = [];

        public IReadOnlyList<ArticlePropertyDefinitionWriteReceipt> Receipts => _receipts;

        public int MaximumLiveSnapshotCount
        {
            get; private set;
        }
        public bool RefuseVerificationResourceAdmission
        {
            get; set;
        }

        public Task<ArticlePropertyDefinition?> GetAsync(
            ArticlePropertyDefinitionOwner owner,
            Guid definitionId,
            CancellationToken cancellationToken = default)
        {
            _definitions.TryGetValue((owner, definitionId), out ArticlePropertyDefinition? definition);
            return Task.FromResult(definition);
        }

        public Task<ArticlePropertyDefinitionPage> ListAsync(
            ArticlePropertyDefinitionOwner owner,
            ArticlePropertyDefinitionPageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
        {
            IEnumerable<ArticlePropertyDefinition> query = _definitions
                .Where(pair => pair.Key.Owner == owner && pair.Value.Status != ArticlePropertyDefinitionStatus.Deleted)
                .Select(static pair => pair.Value)
                .OrderBy(static definition => definition.MachineKey, StringComparer.Ordinal)
                .ThenBy(static definition => definition.DefinitionId);
            if (cursor is not null)
            {
                query = query.Where(definition =>
                    string.CompareOrdinal(definition.MachineKey, cursor.MachineKey) > 0
                    || string.Equals(definition.MachineKey, cursor.MachineKey, StringComparison.Ordinal)
                    && definition.DefinitionId.CompareTo(cursor.DefinitionId) > 0);
            }
            ArticlePropertyDefinition[] items = query.Take(limit + 1).ToArray();
            bool hasMore = items.Length > limit;
            if (hasMore)
            {
                items = items[..limit];
            }
            ArticlePropertyDefinition? last = items.LastOrDefault();
            return Task.FromResult(new ArticlePropertyDefinitionPage(
                items,
                hasMore && last is not null ? new(last.MachineKey, last.DefinitionId) : null,
                _revisions.GetValueOrDefault(owner)));
        }

        public async Task<ArticlePropertyDefinitionWriteReceipt> ExecuteAsync(
            ArticlePropertyDefinitionOwner owner,
            long actorAdminPrincipalId,
            Guid requestId,
            string commandDigest,
            Guid definitionId,
            ArticlePropertyDefinitionRecordedCommand command,
            Func<ArticlePropertyDefinitionMutationSnapshot, CancellationToken, Task<ArticlePropertyDefinitionMutation>> planner,
            CancellationToken cancellationToken = default)
        {
            await _gate.WaitAsync(cancellationToken);
            try
            {
                if (_idempotency.TryGetValue((actorAdminPrincipalId, requestId), out (string Digest, ArticlePropertyDefinitionWriteReceipt Receipt) replay))
                {
                    if (!string.Equals(replay.Digest, commandDigest, StringComparison.Ordinal))
                    {
                        throw new ArticlePropertyDefinitionConflictException("article_property_idempotency_conflict");
                    }
                    if (replay.Receipt.Owner != owner || replay.Receipt.DefinitionId != definitionId
                        || !_historyHeads.ContainsKey(owner)
                        || !_entries.Any(entry => entry.Receipt.ReceiptId == replay.Receipt.ReceiptId)
                        || !_auditRecords.Any(record => record.TargetId == replay.Receipt.AuditReference.ToString("N")
                            && AuditTamperEvidence.Verify(record, s_auditKey)))
                    {
                        throw new ArticlePropertyDefinitionIntegrityException("article_property_idempotency_history_invalid");
                    }
                    return replay.Receipt with
                    {
                        IsIdempotentReplay = true
                    };
                }

                long ownerRevision = _revisions.GetValueOrDefault(owner);
                ArticlePropertyDefinitionCommandHistory.Validate(command);
                if (command.Owner != owner || command.Actor.AdminPrincipalId != actorAdminPrincipalId
                    || command.RequestId != requestId || command.DefinitionId != definitionId)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("memory_history_command_identity_invalid");
                }
                if (!_historyHeads.ContainsKey(owner))
                {
                    if (ownerRevision != 0 || _definitions.Keys.Any(key => key.Owner == owner)
                        || _receipts.Any(receipt => receipt.Owner == owner))
                    {
                        throw new ArticlePropertyDefinitionIntegrityException("article_property_history_unavailable");
                    }
                    _historyHeads.Add(owner, ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(owner));
                }
                ArticlePropertyDefinition[] definitions = _definitions
                    .Where(pair => pair.Key.Owner == owner && pair.Value.Status != ArticlePropertyDefinitionStatus.Deleted)
                    .Select(static pair => pair.Value)
                    .OrderBy(static definition => definition.MachineKey, StringComparer.Ordinal)
                    .ThenBy(static definition => definition.DefinitionId)
                    .Take(ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner + 1)
                    .ToArray();
                if (definitions.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
                {
                    throw new ArticlePropertyDefinitionBudgetExceededException("article_property_definition_budget_exceeded");
                }
                MaximumLiveSnapshotCount = Math.Max(MaximumLiveSnapshotCount, definitions.Length);
                _definitions.TryGetValue((owner, definitionId), out ArticlePropertyDefinition? target);
                ArticlePropertyDefinitionMutation mutation = await planner(
                    new(owner, ownerRevision, definitions, target),
                    cancellationToken);
                if (mutation.ExpectedOwnerRevision != ownerRevision
                    || mutation.Receipt.PreviousOwnerRevision != ownerRevision
                    || mutation.Receipt.OwnerRevision != ownerRevision + 1
                    || mutation.Definition.DefinitionId != definitionId
                    || mutation.Definition.Owner != owner
                    || (mutation.PreviousDefinition is null) != (target is null))
                {
                    throw new ArticlePropertyDefinitionIntegrityException("memory_mutation_invalid");
                }
                if (mutation.Impact is null)
                {
                    throw new ArticlePropertyDefinitionIntegrityException("memory_history_impact_missing");
                }
                var entry = new ArticlePropertyDefinitionJournalEntry(ArticlePropertyDefinitionCommandHistory.Version,
                    owner, mutation.Receipt.OwnerRevision, _historyHeads[owner], command,
                    mutation.Impact, mutation.Receipt, string.Empty);
                entry = entry with
                {
                    ContentDigest = ArticlePropertyDefinitionCommandHistory.ComputeEntryDigest(entry)
                };
                _revisions[owner] = mutation.Receipt.OwnerRevision;
                _definitions[(owner, definitionId)] = mutation.Definition;
                _receipts.Add(mutation.Receipt);
                _idempotency[(actorAdminPrincipalId, requestId)] = (commandDigest, mutation.Receipt);
                _auditLinks.Add(new(
                    mutation.Receipt.AuditReference,
                    ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry),
                    AdminPermissions.ArticleWrite,
                    mutation.Receipt.AuditReference.ToString("N"),
                    "success",
                    true));
                _entries.Add(entry);
                _historyHeads[owner] = entry.ContentDigest;
                string chainId = mutation.Receipt.OccurredAtUtc.ToString("yyyyMMdd", System.Globalization.CultureInfo.InvariantCulture);
                AuditLog? previous = _auditRecords.LastOrDefault(record => record.ChainId == chainId);
                var record = new AuditLog
                {
                    Id = _auditRecords.Count + 1,
                    Source = AuditSourceCatalog.Article,
                    Type = AuditTypeCatalog.Business,
                    OccurredAtUtc = mutation.Receipt.OccurredAtUtc,
                    ActorType = AuditActorTypeCatalog.Admin,
                    ActorId = actorAdminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Action = AdminPermissions.ArticleWrite,
                    Outcome = AuditOutcomeCatalog.Success,
                    Severity = AuditSeverityCatalog.Info,
                    TargetType = "article-property-definition-receipt",
                    TargetId = mutation.Receipt.AuditReference.ToString("N"),
                    IsHighValue = true,
                    ReasonCode = command.CommandKind,
                    EventInfo = ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry),
                    ChainId = chainId,
                    PrevHash = previous?.RecordHash
                };
                AuditTamperEvidenceResult signed = AuditTamperEvidence.Sign(AuditTamperEvidence.FromLog(record), s_auditKey);
                record.RecordHash = signed.RecordHash;
                record.RecordMac = signed.RecordMac;
                _auditRecords.Add(record);
                return mutation.Receipt;
            }
            finally
            {
                _gate.Release();
            }
        }

        public Task<ArticlePropertyDefinitionVerificationSnapshot?> ReadVerificationSnapshotAsync(
            ArticlePropertyDefinitionOwner owner,
            Guid definitionId,
            int receiptLimit,
            CancellationToken cancellationToken = default)
        {
            if (RefuseVerificationResourceAdmission)
            {
                throw new ArticlePropertyDefinitionBudgetExceededException("article_property_verification_resource_budget_exceeded");
            }
            if (!_definitions.TryGetValue((owner, definitionId), out ArticlePropertyDefinition? definition))
            {
                return Task.FromResult<ArticlePropertyDefinitionVerificationSnapshot?>(null);
            }
            ArticlePropertyDefinitionWriteReceipt[] receipts = _receipts
                .Where(receipt => receipt.Owner == owner && receipt.DefinitionId == definitionId)
                .OrderBy(receipt => receipt.SchemaRevision)
                .Take(receiptLimit + 1)
                .ToArray();
            bool exceeded = receipts.Length > receiptLimit;
            if (exceeded)
            {
                receipts = receipts[..receiptLimit];
            }
            Guid[] receiptIds = receipts.Select(static receipt => receipt.ReceiptId).ToArray();
            ArticlePropertyDefinitionIdempotencyRecord[] idempotency = _idempotency
                .Where(pair => receiptIds.Contains(pair.Value.Receipt.ReceiptId))
                .Select(pair => new ArticlePropertyDefinitionIdempotencyRecord(
                    pair.Key.Actor,
                    pair.Key.Request,
                    pair.Value.Digest,
                    pair.Value.Receipt.ReceiptId))
                .ToArray();
            Guid[] auditIds = receipts.Select(static receipt => receipt.AuditReference).ToArray();
            ArticlePropertyDefinitionAuditLink[] links = _auditLinks
                .Where(link => auditIds.Contains(link.AuditReference))
                .ToArray();
            ArticlePropertyDefinitionVerificationSnapshot result = new(
                definition,
                receipts,
                idempotency,
                links,
                exceeded || idempotency.Length > receiptLimit,
                _historyHeads.TryGetValue(owner, out string? head)
                    ? new(ArticlePropertyDefinitionCommandHistory.Version, owner, _revisions.GetValueOrDefault(owner),
                        ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(owner), head,
                        _definitions.Where(pair => pair.Key.Owner == owner).Select(static pair => pair.Value).ToArray(),
                        _entries.Where(entry => entry.Owner == owner).Take(receiptLimit).ToArray(),
                        _idempotency.Values.Where(item => item.Receipt.Owner == owner)
                            .Select(static item => new ArticlePropertyDefinitionIdempotencyRecord(item.Receipt.ActorAdminPrincipalId,
                                item.Receipt.RequestId, item.Digest, item.Receipt.ReceiptId)).ToArray(),
                        _auditRecords.ToArray(), _entries.Count(entry => entry.Owner == owner) > receiptLimit,
                        _auditRecords.Count > receiptLimit)
                    : null);
            if (result.Replay is not null && !ArticlePropertyDefinitionVerifier.IsReplayResourceAdmitted(result.Replay))
            {
                throw new ArticlePropertyDefinitionBudgetExceededException("article_property_verification_resource_budget_exceeded");
            }
            return Task.FromResult<ArticlePropertyDefinitionVerificationSnapshot?>(result);
        }
    }
}
