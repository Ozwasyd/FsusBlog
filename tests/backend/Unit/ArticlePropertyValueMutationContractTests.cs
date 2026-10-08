using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePropertyValueMutationContractTests
{
    private static readonly Guid s_definition = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid s_option = Guid.Parse("00000000-0000-0000-0000-000000000002");

    public static TheoryData<ArticlePropertyTypedValue, ArticlePropertyValueType> TypedPayloads => new()
    {
        { new ArticlePropertyTextValue(string.Empty), ArticlePropertyValueType.Text },
        { new ArticlePropertyNumberValue(decimal.MaxValue), ArticlePropertyValueType.Number },
        { new ArticlePropertyBooleanValue(false), ArticlePropertyValueType.Boolean },
        { new ArticlePropertyDateValue(new DateTime(638962848000000007, DateTimeKind.Utc)), ArticlePropertyValueType.Date },
        { new ArticlePropertySingleSelectValue(s_option), ArticlePropertyValueType.SingleSelect },
        { new ArticlePropertyMultiSelectValue([s_option]), ArticlePropertyValueType.MultiSelect },
        { new ArticlePropertyArticleReferenceValue([]), ArticlePropertyValueType.ArticleReference },
        { new ArticlePropertyUrlValue("https://example.test/"), ArticlePropertyValueType.Url }
    };

    [Theory]
    [MemberData(nameof(TypedPayloads))]
    public void ClosedTypedPayloads_HaveStableStorageAndCommandDigests(
        ArticlePropertyTypedValue payload, ArticlePropertyValueType type)
    {
        ArticlePropertyValueInput input = Input(payload);
        ArticlePropertyValueEntry entry = Entry(input);
        var types = new Dictionary<Guid, ArticlePropertyValueType> { [s_definition] = type };
        ArticlePropertyValuePersistence.ValidateStorageEntries([entry], types);
        Assert.Equal(64, ArticlePropertyValuePersistence.ComputeFactsetDigest([entry], types).Length);
        ArticlePropertyValueMutationCommand command = Command(input);
        Assert.Equal(ArticlePropertyValueMutationContract.ComputeCommandDigest(command),
            ArticlePropertyValueMutationContract.ComputeCommandDigest(ArticlePropertyValueMutationContract.Capture(command)));
        var wrong = new Dictionary<Guid, ArticlePropertyValueType>
        {
            [s_definition] = type == ArticlePropertyValueType.Text ? ArticlePropertyValueType.Boolean : ArticlePropertyValueType.Text
        };
        Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.ValidateStorageEntries([entry], wrong));
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    public void FactsetDigest_AuthenticatesHistoricalTypeEvenWithoutPayload(ArticlePropertyValuePresence presence)
    {
        ArticlePropertyValueEntry entry = Entry(Input(null, presence));
        string text = ArticlePropertyValuePersistence.ComputeFactsetDigest([entry],
            new Dictionary<Guid, ArticlePropertyValueType> { [s_definition] = ArticlePropertyValueType.Text });
        string boolean = ArticlePropertyValuePersistence.ComputeFactsetDigest([entry],
            new Dictionary<Guid, ArticlePropertyValueType> { [s_definition] = ArticlePropertyValueType.Boolean });
        Assert.NotEqual(text, boolean);
    }

    [Fact]
    public void Capture_OwnsCommandCollectionAndCanonicalDefinitionOrder()
    {
        var changes = new List<ArticlePropertyValueChange>
        {
            new(ArticlePropertyValueChangeKind.Create, Input(new ArticlePropertyBooleanValue(false)) with
            {
                DefinitionId = s_option
            }),
            new(ArticlePropertyValueChangeKind.Create, Input(new ArticlePropertyNumberValue(0)))
        };
        ArticlePropertyValueMutationCommand original = Command(changes[0].Input) with
        {
            Changes = changes
        };
        ArticlePropertyValueMutationCommand captured = ArticlePropertyValueMutationContract.Capture(original);
        string digest = ArticlePropertyValueMutationContract.ComputeCommandDigest(captured);
        changes.Clear();
        Assert.Equal(2, captured.Changes.Count);
        Assert.Equal(s_definition, captured.Changes[0].Input.DefinitionId);
        Assert.Equal(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(captured));
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
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    [InlineData(12)]
    [InlineData(13)]
    public void Capture_RejectsInvalidCoordinatesAmbiguousBatchAndRemoveShapes(int mutation)
    {
        ArticlePropertyValueMutationCommand valid = Command(Input(new ArticlePropertyBooleanValue(false)));
        ArticlePropertyValueMutationCommand invalid = mutation switch
        {
            0 => valid with { RequestId = Guid.Empty },
            1 => valid with { ArticleId = 0 },
            2 => valid with { ExpectedArticleRevisionId = 0 },
            3 => valid with { ExpectedPropertyRevision = -1 },
            4 => valid with { DefinitionOwnerUserId = 0 },
            5 => valid with { SiteScope = string.Empty },
            6 => valid with { Mode = (ArticlePropertyValueMutationMode)255 },
            7 => valid with { Changes = [valid.Changes[0], valid.Changes[0]] },
            8 => valid with { Changes = [new(ArticlePropertyValueChangeKind.Remove, valid.Changes[0].Input)] },
            9 => valid with { Changes = [new((ArticlePropertyValueChangeKind)255, valid.Changes[0].Input)] },
            10 => valid with { Changes = [new(ArticlePropertyValueChangeKind.Create, valid.Changes[0].Input with { DefinitionDigest = "bad" })] },
            11 => valid with { Changes = [new(ArticlePropertyValueChangeKind.Create, valid.Changes[0].Input with { DefinitionSchemaRevision = 0 })] },
            12 => valid with { Changes = [new(ArticlePropertyValueChangeKind.Create, valid.Changes[0].Input with { Presence = ArticlePropertyValuePresence.Null })] },
            _ => valid with { Changes = [new(ArticlePropertyValueChangeKind.Remove, Input(null, ArticlePropertyValuePresence.Missing))] }
        };
        Assert.Throws<ArgumentException>(() => ArticlePropertyValueMutationContract.Capture(invalid));
    }

    [Fact]
    public void CommandDigest_BindsCasScopeOperationAndPresence()
    {
        ArticlePropertyValueMutationCommand valid = Command(Input(new ArticlePropertyBooleanValue(false)));
        string digest = ArticlePropertyValueMutationContract.ComputeCommandDigest(valid);
        Assert.NotEqual(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(valid with
        {
            ExpectedPropertyRevision = 1
        }));
        Assert.NotEqual(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(valid with
        {
            ExpectedArticleRevisionId = 2
        }));
        Assert.NotEqual(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(valid with
        {
            DefinitionOwnerUserId = 2
        }));
        Assert.NotEqual(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(valid with
        {
            Mode = ArticlePropertyValueMutationMode.Patch
        }));
        Assert.NotEqual(digest, ArticlePropertyValueMutationContract.ComputeCommandDigest(Command(Input(null, ArticlePropertyValuePresence.Null))));
    }

    [Fact]
    public void FactsetDigest_PreservesDefaultOriginAndSetOrder()
    {
        ArticlePropertyValueInput input = Input(new ArticlePropertyMultiSelectValue([s_definition, s_option]));
        ArticlePropertyValueEntry explicitValue = Entry(input);
        var types = new Dictionary<Guid, ArticlePropertyValueType> { [s_definition] = ArticlePropertyValueType.MultiSelect };
        ArticlePropertyValueEntry defaultValue = explicitValue with
        {
            DefaultApplied = true,
            ValueDigest = ArticlePropertyValueDigest.ComputeValue(input, true)
        };
        Assert.NotEqual(ArticlePropertyValuePersistence.ComputeFactsetDigest([explicitValue], types),
            ArticlePropertyValuePersistence.ComputeFactsetDigest([defaultValue], types));
        ArticlePropertyValueEntry reordered = Entry(input with
        {
            Value = new ArticlePropertyMultiSelectValue([s_option, s_definition])
        });
        Assert.NotEqual(ArticlePropertyValuePersistence.ComputeFactsetDigest([explicitValue], types),
            ArticlePropertyValuePersistence.ComputeFactsetDigest([reordered], types));
    }

    [Fact]
    public async Task Writes_RefuseToCreateAnIndependentTransaction()
    {
        using var db = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.PostgreSQL,
            ConnectionString = "Host=127.0.0.1;Port=1;Database=unit;Username=unit;Password=unit;Pooling=false",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = TestSecrets.AuditTamperEvidenceKey
        }).Build();
        var persistence = new ArticlePropertyValuePersistence(db, configuration, TimeProvider.System);
        ArticlePropertyValueMutationCommand command = Command(Input(new ArticlePropertyBooleanValue(false)));
        ArticlePropertyDefinitionIntegrityException save = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() =>
            persistence.SaveMutationAsync(1, command, null, [], new Dictionary<Guid, ArticlePropertyValueType>(), 2, null));
        Assert.Equal("article_property_value_canonical_transaction_required", save.Message);
        ArticlePropertyDefinitionIntegrityException carry = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() =>
            persistence.CarryForwardAsync(1, 2, null, 1));
        Assert.Equal("article_property_value_canonical_transaction_required", carry.Message);
        ArticlePropertyDefinitionIntegrityException ownerLock = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() =>
            persistence.LockDefinitionOwnersAsync(1, ArticlePropertyDefinitionOwner.Site("primary-site")));
        Assert.Equal("article_property_value_canonical_transaction_required", ownerLock.Message);
        Assert.Null(db.Ado.Transaction);
    }

    [Fact]
    public void DefinitionOwnerLockSet_IsGloballyOrderedAndDetachedIncludingEveryTarget()
    {
        var site = ArticlePropertyDefinitionOwner.Site("primary-site");
        var first = new ArticlePropertyDefinitionOwner(1, "site-a");
        var next = new ArticlePropertyDefinitionOwner(1, "site-b");
        var last = new ArticlePropertyDefinitionOwner(9, "primary-site");
        var owners = new List<ArticlePropertyDefinitionOwner> { last, next, site, first, last };
        IReadOnlyList<ArticlePropertyDefinitionOwner> captured = ArticlePropertyValuePersistence.CaptureDefinitionOwners(owners, first);
        Assert.Equal(new[] { site, first, next, last }, captured);
        foreach (ArticlePropertyDefinitionOwner target in captured)
        {
            Assert.Equal(captured, ArticlePropertyValuePersistence.CaptureDefinitionOwners(owners.AsEnumerable().Reverse(), target));
        }
        owners.Clear();
        Assert.Equal(new[] { site, first, next, last }, captured);
    }

    [Fact]
    public void DefinitionOwnerLockSet_AdmitsBoundAndRefusesOverflowBeforeAcquisition()
    {
        ArticlePropertyDefinitionOwner[] owners = Enumerable.Range(1, 1000)
            .Select(static id => new ArticlePropertyDefinitionOwner(id, "primary-site")).ToArray();
        Assert.Equal(1000, ArticlePropertyValuePersistence.CaptureDefinitionOwners(owners, owners[0]).Count);
        ArticlePropertyDefinitionIntegrityException targetOverflow = Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.CaptureDefinitionOwners(owners, new(1001, "primary-site")));
        Assert.Equal("article_property_value_scope_budget_exceeded", targetOverflow.Message);
        ArticlePropertyDefinitionIntegrityException readOverflow = Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.CaptureDefinitionOwners(owners.Append(new(1001, "primary-site"))));
        Assert.Equal("article_property_value_scope_budget_exceeded", readOverflow.Message);
    }

    [Fact]
    public void DefinitionOwnerLockSet_ValidatesCurrentCanonicalOwnerContract()
    {
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() =>
            ArticlePropertyValuePersistence.CaptureDefinitionOwners([new(0, "primary-site")]));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() =>
            ArticlePropertyValuePersistence.CaptureDefinitionOwners([], new(1, " primary-site")));
    }

    private static ArticlePropertyValueInput Input(ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present)
        => new(s_definition, 1, new string('a', 64), presence, value);

    private static ArticlePropertyValueEntry Entry(ArticlePropertyValueInput input)
        => new(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
            input.Presence, input.Value, ArticlePropertyValueDigest.ComputeValue(input));

    private static ArticlePropertyValueMutationCommand Command(ArticlePropertyValueInput input)
        => new(Guid.Parse("00000000-0000-0000-0000-000000000003"), 1, "primary-site", 1, 1, 0,
            ArticlePropertyValueMutationMode.Replace, [new(ArticlePropertyValueChangeKind.Create, input)]);
}
