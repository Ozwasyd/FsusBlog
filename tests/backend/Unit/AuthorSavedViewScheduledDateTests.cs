using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorSavedViewScheduledDateTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(42, "scheduled-site");

    [Theory]
    [InlineData("value.is-missing", 0)]
    [InlineData("value.is-present", 0)]
    [InlineData("date.before", 1)]
    [InlineData("date.on-or-before", 1)]
    [InlineData("date.after", 1)]
    [InlineData("date.on-or-after", 1)]
    [InlineData("date.between", 2)]
    public async Task ScheduledField_ReusesExistingDateOperatorsAndExplicitTimezone(string operatorId, int valueCount)
    {
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));
        string[] values = valueCount switch
        {
            0 => [],
            1 => ["2026-03-29"],
            _ => ["2026-03-29", "2026-10-25"]
        };
        AuthorSavedViewQuery query = Query(AuthorSavedViewContract.ScheduledAtField, operatorId, values);
        AuthorSavedViewQueryValidationResult validation = await validator.ValidateAsync(s_owner, query);
        Assert.True(validation.IsValid);
        AuthorSavedViewCondition condition = Assert.Single(validation.Query.Conditions);
        Assert.Equal(AuthorSavedViewContract.ScheduledAtField, condition.Field.Identity);
        Assert.Equal(valueCount == 0 ? null : "Europe/Berlin", condition.TimeZoneId);
        Assert.Equal("UTC", validation.Query.Sort.TimeZoneId);
        Assert.Equal(AuthorSavedViewNullPlacement.Last, validation.Query.Sort.NullPlacement);
        Assert.Equal(AuthorSavedViewContract.ArticleIdentityTieBreaker, validation.Query.Sort.StableTieBreaker);
        AuthorSavedViewOperatorDescriptor descriptor = AuthorSavedViewContract.Operators[operatorId];
        Assert.Equal(descriptor.Id, validation.Resolutions[0].Operator.Id);
        Assert.Equal(descriptor.QueryOwner, validation.Resolutions[0].Operator.QueryOwner);
        Assert.Equal(descriptor.NullSemantics, validation.Resolutions[0].Operator.NullSemantics);
        Assert.Equal(descriptor.DateBoundary, validation.Resolutions[0].Operator.DateBoundary);
        Assert.All(validation.Resolutions, dependency =>
        {
            Assert.Equal(AuthorSavedViewDependencyStatus.Current, dependency.Status);
            Assert.Equal(AuthorSavedViewContract.ScheduledAtField, dependency.Dependency.Identity);
        });
        Assert.Contains(AuthorSavedViewContract.ScheduledAtField,
            AuthorSavedViewContract.Fields[AuthorSavedViewFieldKind.Date].ExactIdentities);
        Assert.Equal(12, AuthorSavedViewContract.Operators.Count);
    }

    [Theory]
    [InlineData("ScheduledPublishAt")]
    [InlineData("article.schedule")]
    [InlineData("article.scheduledPublishAt")]
    [InlineData("article.scheduled-at-v2")]
    public async Task UnknownScheduledAliases_AreRejectedByTheClosedOwner(string identity)
    {
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));
        AuthorSavedViewValidationException error = await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() =>
            validator.ValidateAsync(s_owner, Query(identity, "date.before", ["2026-03-29"])));
        Assert.Equal("saved_view_field_identity_unknown", error.Code);
    }

    [Fact]
    public async Task ScheduledIdentity_HasDistinctDigestAndRetainsFutureSchemaRefusal()
    {
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));
        AuthorSavedViewQuery scheduled = Query(AuthorSavedViewContract.ScheduledAtField, "date.before", ["2026-03-29"]);
        AuthorSavedViewQueryValidationResult validation = await validator.ValidateAsync(s_owner, scheduled);
        AuthorSavedViewQueryValidationResult published = await validator.ValidateAsync(s_owner,
            Query(AuthorSavedViewContract.PublishedAtField, "date.before", ["2026-03-29"]));
        Assert.NotEqual(validation.QueryDigest, published.QueryDigest);
        Assert.Equal("saved_view_query_future_schema",
            (await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() =>
                validator.ValidateAsync(s_owner, scheduled with
                {
                    SchemaVersion = AuthorSavedViewContract.SchemaVersion + 1
                }))).Code);
    }

    private static AuthorSavedViewQuery Query(string identity, string operatorId, IReadOnlyList<string> values)
        => new(AuthorSavedViewContract.SchemaVersion,
            [new(new(AuthorSavedViewFieldKind.Date, identity), operatorId, values, values.Count == 0 ? null : "Europe/Berlin")],
            new(new(AuthorSavedViewFieldKind.Date, identity), AuthorSavedViewSortDirection.Ascending,
                AuthorSavedViewNullPlacement.Last, "temporal", TimeZoneId: "UTC"),
            [new(AuthorSavedViewFieldKind.Date, identity)], 25);
}
