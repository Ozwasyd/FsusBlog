using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure foundation controls; these do not certify article transaction or relation runtime acceptance.</summary>
public sealed class ArticlePropertyValueFoundationTests
{
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.User(42, "site-a");
    private static readonly ArticlePropertyDefinitionActor s_actor = new(42, [AdminPermissions.ArticleWrite]);
    private static readonly DateTime s_now = new(2026, 10, 8, 12, 0, 0, DateTimeKind.Utc);
    private static readonly Guid s_option = Guid.Parse("10000000-0000-0000-0000-000000000001");
    private static readonly Guid s_otherOption = Guid.Parse("10000000-0000-0000-0000-000000000002");

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task Validator_UsesCurrentDefinitionsForAllEightTypedCases(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        (ArticlePropertyValueValidator validator, IArticlePropertyDefinitionStore store,
            IArticlePropertyReferenceValueAuthority references) = Validator(definition);
        ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, Value(type))]));

        Assert.Equal(definition.DefinitionId, entry.DefinitionId);
        Assert.Equal(definition.ContentDigest, entry.DefinitionDigest);
        Assert.Equal(ArticlePropertyValuePresence.Present, entry.Presence);
        Assert.Equal(ArticlePropertyValueDigest.ComputeValue(new ArticlePropertyValueInput(entry.DefinitionId,
            entry.DefinitionSchemaRevision, entry.DefinitionDigest, entry.Presence, entry.Value)), entry.ValueDigest);
        await store.Received(1).GetAsync(s_actor, s_owner, definition.DefinitionId, Arg.Any<CancellationToken>());
        if (type == ArticlePropertyValueType.ArticleReference)
        {
            await references.Received(1).RequireAllowedAsync(Arg.Is<ArticlePropertyReferenceValueQuery>(query =>
                query.Owner == s_owner && query.SourceArticleId == 7 && query.DefinitionId == definition.DefinitionId
                && query.TargetArticleIds.SequenceEqual(new long[] { 8, 9 })), Arg.Any<CancellationToken>());
        }
        else
        {
            await references.DidNotReceiveWithAnyArgs().RequireAllowedAsync(default!, default);
        }
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
    public async Task Validator_RejectsPayloadOfAnotherRegisteredType(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        ArticlePropertyTypedValue wrong = type == ArticlePropertyValueType.Text
            ? new ArticlePropertyBooleanValue(false) : new ArticlePropertyTextValue("value");
        var (validator, _, _) = Validator(definition);

        Assert.Equal("article_property_value_type_mismatch", (await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateAsync(s_actor, s_owner, 7, [Input(definition, wrong)]))).Code);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("digest")]
    [InlineData("retired")]
    [InlineData("owner")]
    public async Task Validator_RejectsStaleOrWrongDefinitionBinding(string drift)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        ArticlePropertyValueInput input = Input(definition, new ArticlePropertyTextValue("text"));
        if (drift == "revision")
        {
            input = input with
            {
                DefinitionSchemaRevision = input.DefinitionSchemaRevision + 1
            };
        }
        if (drift == "digest")
        {
            input = input with
            {
                DefinitionDigest = new string('0', 64)
            };
        }
        if (drift == "retired")
        {
            definition = Seal(definition with
            {
                Status = ArticlePropertyDefinitionStatus.Deprecated
            });
        }
        if (drift == "owner")
        {
            definition = Seal(definition with
            {
                Owner = ArticlePropertyDefinitionOwner.User(42, "site-b")
            });
        }
        var (validator, _, _) = Validator(definition);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateAsync(s_actor, s_owner, 7, [input]));
    }

    [Fact]
    public async Task Validator_PreservesMissingNullZeroFalseAndExplicitEmpty()
    {
        foreach (ArticlePropertyValuePresence presence in new[] { ArticlePropertyValuePresence.Missing, ArticlePropertyValuePresence.Null })
        {
            ArticlePropertyDefinition text = Definition(ArticlePropertyValueType.Text);
            var (validator, _, _) = Validator(text);
            ArticlePropertyValueEntry absent = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
                [new ArticlePropertyValueInput(text.DefinitionId, text.SchemaRevision, text.ContentDigest, presence, null)]));
            Assert.Equal(presence, absent.Presence);
            Assert.Null(absent.Value);
        }
        foreach (ArticlePropertyValueType type in new[] { ArticlePropertyValueType.Number, ArticlePropertyValueType.Boolean, ArticlePropertyValueType.Text })
        {
            ArticlePropertyDefinition definition = Definition(type);
            ArticlePropertyTypedValue value = type switch
            {
                ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0),
                ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
                _ => new ArticlePropertyTextValue(string.Empty)
            };
            var (validator, _, _) = Validator(definition);
            ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7, [Input(definition, value)]));
            Assert.Equal(ArticlePropertyValuePresence.Present, entry.Presence);
            Assert.Equal(value, entry.Value);
        }
    }

    [Fact]
    public async Task Validator_DefaultAppliesOnlyToMissingAndUsesDefinitionNormalization()
    {
        ArticlePropertyDefinition definition = Seal(Definition(ArticlePropertyValueType.Boolean) with
        {
            Presence = new ArticlePropertyPresencePolicy(ArticlePropertyMissingBehavior.ApplyDefault,
                ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            DefaultValue = new ArticlePropertyDefaultValue(ArticlePropertyDefaultKind.Scalar, Scalar: "true")
        });
        var (validator, _, _) = Validator(definition);
        ArticlePropertyValueEntry missing = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest,
                ArticlePropertyValuePresence.Missing, null)]));
        Assert.Equal(new ArticlePropertyBooleanValue(true), missing.Value);
        Assert.True(missing.DefaultApplied);
        ArticlePropertyValueEntry present = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, new ArticlePropertyBooleanValue(false))]));
        Assert.Equal(new ArticlePropertyBooleanValue(false), present.Value);
        Assert.False(present.DefaultApplied);
        ArticlePropertyValueEntry identicalExplicit = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, new ArticlePropertyBooleanValue(true))]));
        Assert.Equal(missing.Value, identicalExplicit.Value);
        Assert.False(identicalExplicit.DefaultApplied);
        Assert.NotEqual(missing.ValueDigest, identicalExplicit.ValueDigest);
        var coordinates = new ArticlePropertySnapshotCoordinates(42, "site-a", 7, 1, 100);
        ArticlePropertyValueSnapshot applied = ArticlePropertyValueValidator.BindSnapshot(coordinates, [missing]);
        ArticlePropertyValueSnapshot explicitSnapshot = ArticlePropertyValueValidator.BindSnapshot(coordinates, [identicalExplicit]);
        Assert.True(Assert.Single(applied.Values).DefaultApplied);
        Assert.NotEqual(applied.ContentDigest, explicitSnapshot.ContentDigest);
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task NewArticleInputs_ValidatePrimitiveValuesWithoutAllocatingOrInventingAnArticleIdentity(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        var (validator, _, references) = Validator(definition);

        ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateInputsAsync(s_actor, s_owner,
            [Input(definition, Value(type))]));

        Assert.Equal(ArticlePropertyValuePresence.Present, entry.Presence);
        Assert.Equal(definition.DefinitionId, entry.DefinitionId);
        await references.DidNotReceiveWithAnyArgs().RequireAllowedAsync(default!, default);
    }

    [Fact]
    public async Task NewArticleInputs_NonemptyReferencesRefuseWithoutCanonicalSourceIdentity()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.ArticleReference);
        var (validator, _, references) = Validator(definition);

        Assert.Equal("article_property_reference_source_identity_unavailable", (await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateInputsAsync(s_actor, s_owner, [Input(definition, new ArticlePropertyArticleReferenceValue([8]))]))).Code);

        await references.DidNotReceiveWithAnyArgs().RequireAllowedAsync(default!, default);
    }

    [Fact]
    public async Task NewArticleInputs_ExplicitEmptyReferencesRemainEmptyWithoutTargetValidation()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.ArticleReference);
        var (validator, _, references) = Validator(definition);

        ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateInputsAsync(s_actor, s_owner,
            [Input(definition, new ArticlePropertyArticleReferenceValue([]))]));

        Assert.Empty(Assert.IsType<ArticlePropertyArticleReferenceValue>(entry.Value).ArticleIds);
        Assert.Equal(ArticlePropertyValuePresence.Present, entry.Presence);
        await references.DidNotReceiveWithAnyArgs().RequireAllowedAsync(default!, default);
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    public async Task Validator_RequiredRejectsMissingAndNull(ArticlePropertyValuePresence presence)
    {
        ArticlePropertyDefinition definition = Seal(Definition(ArticlePropertyValueType.Text) with
        {
            Required = true,
            Presence = new ArticlePropertyPresencePolicy(ArticlePropertyMissingBehavior.PreserveMissing,
                ArticlePropertyNullBehavior.RejectNull, ArticlePropertyEmptyBehavior.PreserveEmpty)
        });
        var (validator, _, _) = Validator(definition);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            [new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest, presence, null)]));
    }

    [Fact]
    public async Task Validator_CanonicalizesUnicodeUrlAndUnorderedOptionSets()
    {
        ArticlePropertyDefinition text = Definition(ArticlePropertyValueType.Text);
        var (validator, _, _) = Validator(text);
        ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(text, new ArticlePropertyTextValue("e\u0301"))]));
        Assert.Equal(new ArticlePropertyTextValue("é"), entry.Value);

        ArticlePropertyDefinition url = Definition(ArticlePropertyValueType.Url);
        (validator, _, _) = Validator(url);
        entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(url, new ArticlePropertyUrlValue("HTTPS://EXAMPLE.COM/Path"))]));
        Assert.Equal(new ArticlePropertyUrlValue(ArticlePropertyDefinitionContract.NormalizeUrl(
            "HTTPS://EXAMPLE.COM/Path", url.UrlPolicy!)), entry.Value);

        ArticlePropertyDefinition multi = Definition(ArticlePropertyValueType.MultiSelect);
        (validator, _, _) = Validator(multi);
        entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(multi, new ArticlePropertyMultiSelectValue([s_otherOption, s_option]))]));
        Assert.Equal(new[] { s_option, s_otherOption }, Assert.IsType<ArticlePropertyMultiSelectValue>(entry.Value).OptionIds);
    }

    [Fact]
    public async Task Validator_RejectsConstraintsUnknownOptionsDuplicatesAndUnsafeUrls()
    {
        ArticlePropertyDefinition number = Seal(Definition(ArticlePropertyValueType.Number) with
        {
            Constraints = new ArticlePropertyConstraints(MinNumber: 1, MaxNumber: 2)
        });
        var (validator, _, _) = Validator(number);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(number, new ArticlePropertyNumberValue(0))]));
        ArticlePropertyDefinition options = Definition(ArticlePropertyValueType.MultiSelect);
        (validator, _, _) = Validator(options);
        foreach (Guid[] ids in new[] { new[] { s_option, s_option }, new[] { Guid.CreateVersion7() } })
        {
            await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
                [Input(options, new ArticlePropertyMultiSelectValue(ids))]));
        }
        ArticlePropertyDefinition url = Definition(ArticlePropertyValueType.Url);
        (validator, _, _) = Validator(url);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(url, new ArticlePropertyUrlValue("javascript:alert(1)"))]));
        ArticlePropertyDefinition date = Definition(ArticlePropertyValueType.Date);
        (validator, _, _) = Validator(date);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(date, new ArticlePropertyDateValue(DateTime.SpecifyKind(s_now, DateTimeKind.Unspecified)))]));
    }

    [Fact]
    public async Task Validator_ReferenceAuthorityUnavailableAndSelfReferenceFailClosed()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.ArticleReference);
        var (_, store, _) = Validator(definition);
        var validator = new ArticlePropertyValueValidator(store, new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyReferenceValueAuthority());
        Assert.Equal("article_property_reference_authority_unavailable", (await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateAsync(s_actor, s_owner, 7, [Input(definition, new ArticlePropertyArticleReferenceValue([8]))]))).Code);
        Assert.Equal("article_property_reference_rejected", (await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateAsync(s_actor, s_owner, 7, [Input(definition, new ArticlePropertyArticleReferenceValue([7]))]))).Code);
    }

    [Fact]
    public async Task Validator_PermissionCancellationAndBoundRejectBeforeAnyDefinitionRead()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        var (validator, store, _) = Validator(definition);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => validator.ValidateAsync(
            new ArticlePropertyDefinitionActor(42, []), s_owner, 7, []));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => validator.ValidateAsync(
            s_actor, ArticlePropertyDefinitionOwner.User(77, "site-a"), 7, []));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, new ArticlePropertyTextValue("x"))], new CancellationToken(canceled: true)));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => validator.ValidateAsync(s_actor, s_owner, 7,
            Enumerable.Range(0, 1001).Select(_ => Input(definition, new ArticlePropertyTextValue("x"))).ToArray()));
        await store.DidNotReceiveWithAnyArgs().GetAsync(default!, default, default, default);
    }

    [Fact]
    public async Task Validator_AcceptsOneThousandCurrentDefinitionsWithoutWritingToTheirOwner()
    {
        ArticlePropertyDefinition[] definitions = Enumerable.Range(0, 1000)
            .Select(_ => Definition(ArticlePropertyValueType.Number)).ToArray();
        var byId = definitions.ToDictionary(static definition => definition.DefinitionId);
        IArticlePropertyDefinitionStore store = Substitute.For<IArticlePropertyDefinitionStore>();
        store.GetAsync(s_actor, s_owner, Arg.Any<Guid>(), Arg.Any<CancellationToken>())
            .Returns(call => byId[call.Arg<Guid>()]);
        var validator = new ArticlePropertyValueValidator(store, new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyReferenceValueAuthority());

        IReadOnlyList<ArticlePropertyValueEntry> entries = await validator.ValidateAsync(s_actor, s_owner, 7,
            definitions.Select(definition => Input(definition, new ArticlePropertyNumberValue(0))).ToArray());

        Assert.Equal(1000, entries.Count);
        Assert.Equal(byId.Keys.Order(), entries.Select(static entry => entry.DefinitionId));
        Assert.All(entries, entry => Assert.Equal(new ArticlePropertyNumberValue(0), entry.Value));
        await store.DidNotReceiveWithAnyArgs().CreateAsync(default!, default);
        await store.DidNotReceiveWithAnyArgs().UpdateAsync(default!, default);
        await store.DidNotReceiveWithAnyArgs().DeleteAsync(default!, default);
    }

    [Fact]
    public async Task Snapshot_ImmutableAndBindsObservedCoordinatesDefinitionAndTypedValues()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.MultiSelect);
        var (validator, _, _) = Validator(definition);
        Guid[] source = [s_option];
        var typed = new ArticlePropertyMultiSelectValue(source);
        source[0] = s_otherOption;
        ArticlePropertyValueEntry[] entries = (await validator.ValidateAsync(s_actor, s_owner, 7, [Input(definition, typed)])).ToArray();
        var coordinates = new ArticlePropertySnapshotCoordinates(42, "site-a", 7, 1, 100, 200, 1);
        ArticlePropertyValueSnapshot snapshot = ArticlePropertyValueValidator.BindSnapshot(coordinates, entries);
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(snapshot);
        string digest = snapshot.ContentDigest;
        entries[0] = entries[0] with
        {
            ValueDigest = new string('0', 64)
        };
        Assert.Equal(new[] { s_option }, Assert.IsType<ArticlePropertyMultiSelectValue>(Assert.Single(snapshot.Values).Value).OptionIds);
        Assert.Equal(digest, ArticlePropertyValueDigest.ComputeSnapshot(snapshot.Coordinates, snapshot.Values));
        Assert.NotEqual(digest, ArticlePropertyValueDigest.ComputeSnapshot(coordinates with
        {
            ArticleRevisionId = 101
        }, snapshot.Values));
        Assert.NotEqual(digest, ArticlePropertyValueDigest.ComputeSnapshot(coordinates with
        {
            PropertyRevision = 2
        }, snapshot.Values));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyValueValidator.BindSnapshot(coordinates, entries));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyValueValidator.BindSnapshot(
            coordinates with
            {
                DraftServerRevision = null
            }, snapshot.Values));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyValueValidator.BindSnapshot(
            coordinates with
            {
                PublicationId = 300
            }, snapshot.Values));
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("snapshot-digest")]
    [InlineData("value-digest")]
    public async Task SnapshotCandidate_RejectsUnknownSchemaAndTamperedDigests(string drift)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var (validator, _, _) = Validator(definition);
        IReadOnlyList<ArticlePropertyValueEntry> entries = await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, new ArticlePropertyNumberValue(0))]);
        ArticlePropertyValueSnapshot valid = ArticlePropertyValueValidator.BindSnapshot(
            new ArticlePropertySnapshotCoordinates(42, "site-a", 7, 1, 100), entries);
        ArticlePropertyValueSnapshot bad = new(drift == "schema" ? 2 : 1, valid.Coordinates,
            drift == "value-digest" ? [entries[0] with { ValueDigest = new string('0', 64) }] : entries,
            drift == "snapshot-digest" ? new string('0', 64) : valid.ContentDigest);

        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticlePropertyValueValidator.ValidateSnapshotCandidate(bad));
    }

    [Fact]
    public async Task Snapshot_FreezesMutableCallerViewBeforeCheckingAndHashing()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var (validator, _, _) = Validator(definition);
        ArticlePropertyValueEntry entry = Assert.Single(await validator.ValidateAsync(s_actor, s_owner, 7,
            [Input(definition, new ArticlePropertyNumberValue(0))]));
        var changing = new ChangingValues(entry);

        ArticlePropertyValueSnapshot snapshot = ArticlePropertyValueValidator.BindSnapshot(
            new ArticlePropertySnapshotCoordinates(42, "site-a", 7, 1, 100), changing);

        Assert.Equal(1, changing.EnumerationCount);
        Assert.Same(entry, Assert.Single(snapshot.Values));
        ArticlePropertyValueValidator.ValidateSnapshotCandidate(snapshot);
    }

    private sealed class ChangingValues(ArticlePropertyValueEntry entry) : IReadOnlyList<ArticlePropertyValueEntry>
    {
        public int EnumerationCount
        {
            get; private set;
        }
        public int Count => 1;
        public ArticlePropertyValueEntry this[int index] => index == 0 ? entry : throw new IndexOutOfRangeException();

        public IEnumerator<ArticlePropertyValueEntry> GetEnumerator()
        {
            EnumerationCount++;
            yield return EnumerationCount == 1 ? entry : entry with
            {
                ValueDigest = new string('0', 64)
            };
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private static (ArticlePropertyValueValidator, IArticlePropertyDefinitionStore, IArticlePropertyReferenceValueAuthority) Validator(
        ArticlePropertyDefinition definition)
    {
        IArticlePropertyDefinitionStore store = Substitute.For<IArticlePropertyDefinitionStore>();
        store.GetAsync(Arg.Any<ArticlePropertyDefinitionActor>(), Arg.Any<ArticlePropertyDefinitionOwner>(),
            Arg.Any<Guid>(), Arg.Any<CancellationToken>()).Returns(definition);
        // Keep per-case GetAsync overrides effective through the canonical batch port.
        store.GetManyAsync(Arg.Any<ArticlePropertyDefinitionActor>(), Arg.Any<ArticlePropertyDefinitionOwner>(),
            Arg.Any<IReadOnlyList<Guid>>(), Arg.Any<CancellationToken>()).Returns<Task<IReadOnlyList<ArticlePropertyDefinition>>>(async call =>
        {
            var result = new List<ArticlePropertyDefinition>();
            foreach (Guid id in ArticlePropertyDefinitionBatchRead.HoldIds(call.ArgAt<IReadOnlyList<Guid>>(2)))
            {
                CancellationToken cancellation = call.ArgAt<CancellationToken>(3);
                cancellation.ThrowIfCancellationRequested();
                ArticlePropertyDefinition? found = await store.GetAsync(call.ArgAt<ArticlePropertyDefinitionActor>(0),
                    call.ArgAt<ArticlePropertyDefinitionOwner>(1), id, cancellation);
                if (found is not null)
                {
                    result.Add(found);
                }
            }
            return result.AsReadOnly();
        });
        IArticlePropertyReferenceValueAuthority references = Substitute.For<IArticlePropertyReferenceValueAuthority>();
        return (new ArticlePropertyValueValidator(store, new ArticlePropertyDefinitionPermissionAuthority(), references), store, references);
    }

    private static ArticlePropertyValueInput Input(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value)
        => new(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest, ArticlePropertyValuePresence.Present, value);

    private static ArticlePropertyTypedValue Value(ArticlePropertyValueType type)
        => type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue("text"),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(s_now),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(s_option),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([s_option, s_otherOption]),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([8, 9]),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/path"),
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        ArticlePropertyCardinality cardinality = multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        return Seal(new ArticlePropertyDefinition(ArticlePropertyDefinitionContract.SchemaVersion, Guid.CreateVersion7(), s_owner,
            "field", [new ArticlePropertyLocalizedName("en", "Field")], type, cardinality, false,
            new ArticlePropertyPresencePolicy(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), null, new ArticlePropertyConstraints(),
            type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new ArticlePropertyOption(s_option, "One", 0, ArticlePropertyOptionStatus.Active),
                    new ArticlePropertyOption(s_otherOption, "Two", 1, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference ? new ArticlePropertyReferencePolicy(cardinality,
                ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new ArticlePropertyUrlPolicy(["https"], false, true, 2048,
                ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_now, s_now, string.Empty));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };
}
