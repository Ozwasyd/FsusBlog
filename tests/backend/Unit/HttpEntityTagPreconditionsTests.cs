using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HttpEntityTagPreconditionsTests
{
    [Theory]
    [InlineData("\"detail\"", "\"detail\"")]
    [InlineData("W/\"detail\"", "\"detail\"")]
    [InlineData("\"detail\"", "W/\"detail\"")]
    [InlineData("W/\"detail\"", "W/\"detail\"")]
    [InlineData("\"other\", W/\"detail\"", "\"detail\"")]
    [InlineData("\"other\", W/\"de,tail\"", "\"de,tail\"")]
    [InlineData("*", "\"detail\"")]
    public void MatchesIfNoneMatch_UsesRfcWeakComparison(string validators, string selectedTag)
    {
        Assert.True(HttpEntityTagPreconditions.MatchesIfNoneMatch(validators, selectedTag));
    }

    [Fact]
    public void MatchesIfNoneMatch_CombinesMultipleHeaderFieldValues()
    {
        var validators = new StringValues(["\"other\"", "W/\"detail\""]);

        Assert.True(HttpEntityTagPreconditions.MatchesIfNoneMatch(validators, "\"detail\""));
    }

    [Theory]
    [InlineData("")]
    [InlineData("\"other\"")]
    [InlineData("\"detail\",")]
    [InlineData("\"detail\", invalid")]
    [InlineData("*, \"detail\"")]
    [InlineData("W/ \"detail\"")]
    [InlineData("w/\"detail\"")]
    [InlineData("\"de\u0100tail\"")]
    public void MatchesIfNoneMatch_RejectsNonmatchingOrInvalidLists(string validators)
    {
        Assert.False(HttpEntityTagPreconditions.MatchesIfNoneMatch(validators, "\"detail\""));
    }

    [Fact]
    public void MatchesIfNoneMatch_RejectsWildcardCombinedAcrossHeaderFieldValues()
    {
        var validators = new StringValues(["*", "\"detail\""]);

        Assert.False(HttpEntityTagPreconditions.MatchesIfNoneMatch(validators, "\"detail\""));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("*")]
    [InlineData("\"detail\" trailing")]
    [InlineData("\"de\u0100tail\"")]
    public void MatchesIfNoneMatch_RejectsMissingOrInvalidSelectedTag(string? selectedTag)
    {
        Assert.False(HttpEntityTagPreconditions.MatchesIfNoneMatch("\"detail\"", selectedTag));
    }
}
