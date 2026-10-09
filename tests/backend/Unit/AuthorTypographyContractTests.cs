using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorTypographyContractTests
{
    [Fact]
    public void Catalog_ClosesExactlyFiveDimensionsAndTheirIds()
    {
        Assert.Equal(["fontFamily", "fontSize", "lineHeight", "canvasWidth", "paragraphSpacing"],
            AuthorTypographyCatalog.Dimensions.Keys);
        Assert.Equal(["system-sans", "reading-serif", "cjk-sans"], AuthorTypographyCatalog.Dimensions["fontFamily"]);
        Assert.Equal(["compact", "standard", "large"], AuthorTypographyCatalog.Dimensions["fontSize"]);
        Assert.Equal(["compact", "standard", "relaxed"], AuthorTypographyCatalog.Dimensions["lineHeight"]);
        Assert.Equal(["narrow", "standard", "wide"], AuthorTypographyCatalog.Dimensions["canvasWidth"]);
        Assert.Equal(["compact", "standard", "relaxed"], AuthorTypographyCatalog.Dimensions["paragraphSpacing"]);
    }

    [Fact]
    public void All243Combinations_AreAdmittedWithoutASecondModel()
    {
        int count = 0;
        foreach (string family in AuthorTypographyCatalog.Dimensions["fontFamily"])
            foreach (string size in AuthorTypographyCatalog.Dimensions["fontSize"])
                foreach (string height in AuthorTypographyCatalog.Dimensions["lineHeight"])
                    foreach (string width in AuthorTypographyCatalog.Dimensions["canvasWidth"])
                        foreach (string spacing in AuthorTypographyCatalog.Dimensions["paragraphSpacing"])
                        {
                            Dictionary<string, string> fields = Fields();
                            fields["fontFamily"] = family;
                            fields["fontSize"] = size;
                            fields["lineHeight"] = height;
                            fields["canvasWidth"] = width;
                            fields["paragraphSpacing"] = spacing;
                            Assert.True(AuthorTypographyContractValidator.TryCreateProfile(1, fields, out AuthorTypographyProfile? profile));
                            Assert.True(AuthorTypographyContractValidator.ValidateProfile(profile));
                            count++;
                        }
        Assert.Equal(243, count);
    }

    [Theory]
    [InlineData("18px")]
    [InlineData("1.8")]
    [InlineData("font-size:18px")]
    [InlineData("https://fonts.example.test/font.woff2")]
    [InlineData("STANDARD")]
    [InlineData(" standard")]
    [InlineData("")]
    [InlineData(null)]
    public void ArbitraryValues_FailEveryDimension(string? value)
    {
        foreach (string dimension in AuthorTypographyCatalog.Dimensions.Keys)
        {
            Dictionary<string, string> fields = Fields();
            fields[dimension] = value!;
            Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, fields, out _));
        }
    }

    [Theory]
    [InlineData("mode")]
    [InlineData("article")]
    [InlineData("selection")]
    [InlineData("scroll")]
    [InlineData("epoch")]
    [InlineData("css")]
    [InlineData("fontUrl")]
    [InlineData("publicTheme")]
    public void ExtraFields_FailRatherThanBeingIgnored(string field)
    {
        Dictionary<string, string> fields = Fields();
        fields[field] = "standard";
        Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, fields, out _));
        fields.Remove("fontSize");
        Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, fields, out _));
    }

    [Fact]
    public void MissingFutureCorruptAndCaseFoldedProfiles_Refuse()
    {
        Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, null, out _));
        foreach (int version in new[] { -1, 0, 2, int.MaxValue })
        {
            Assert.False(AuthorTypographyContractValidator.TryCreateProfile(version, Fields(), out _));
        }
        foreach (string dimension in AuthorTypographyCatalog.Dimensions.Keys)
        {
            Dictionary<string, string> missing = Fields();
            missing.Remove(dimension);
            Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, missing, out _));
            var folded = new Dictionary<string, string>(Fields(), StringComparer.OrdinalIgnoreCase);
            string value = folded[dimension];
            folded.Remove(dimension);
            folded[dimension.ToUpperInvariant()] = value;
            Assert.False(AuthorTypographyContractValidator.TryCreateProfile(1, folded, out _));
        }
    }

    [Fact]
    public void Snapshot_IsScopedAndContentAddressedButNotAnAuthorizationOrCasReceipt()
    {
        Assert.True(AuthorTypographyContractValidator.TryCreateProfile(1, Fields(), out AuthorTypographyProfile? profile));
        var scope = new AuthorTypographyScope(42, "site:primary");
        var snapshot = new AuthorTypographySnapshot(scope, 3, profile!, string.Empty);
        snapshot = snapshot with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(snapshot)
        };
        Assert.Equal(AuthorTypographyContractStatus.Valid, AuthorTypographyContractValidator.ValidateSnapshot(snapshot, scope));
        Assert.Equal(AuthorTypographyContractStatus.ScopeMismatch,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot, scope with
            {
                AccountId = 43
            }));
        Assert.Equal(AuthorTypographyContractStatus.ScopeMismatch,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot, scope with
            {
                SiteIdentity = "site:other"
            }));
        Assert.Equal(AuthorTypographyContractStatus.InvalidScope,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot, scope with
            {
                AccountId = 0
            }));
        Assert.Equal(AuthorTypographyContractStatus.InvalidRevision,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot with
            {
                Revision = -1
            }, scope));
        Assert.Equal(AuthorTypographyContractStatus.DigestMismatch,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot with
            {
                Revision = 4
            }, scope));
        Assert.Equal(AuthorTypographyContractStatus.DigestMismatch,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot with
            {
                Profile = profile! with
                {
                    FontSize = "large"
                }
            }, scope));
        Assert.Equal(AuthorTypographyContractStatus.InvalidProfile,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot with
            {
                Profile = profile! with
                {
                    SchemaVersion = 2
                }
            }, scope));
        Assert.Equal(AuthorTypographyContractStatus.DigestMismatch,
            AuthorTypographyContractValidator.ValidateSnapshot(snapshot with
            {
                ContentDigest = new string('a', 64)
            }, scope));
    }

    [Fact]
    public void Catalog_CannotBeMutatedByConsumers()
    {
        var dimensions = Assert.IsAssignableFrom<IDictionary<string, IReadOnlyList<string>>>(AuthorTypographyCatalog.Dimensions);
        Assert.Throws<NotSupportedException>(() => dimensions.Add("css", Array.Empty<string>()));
        var values = Assert.IsAssignableFrom<IList<string>>(AuthorTypographyCatalog.Dimensions["fontSize"]);
        Assert.Throws<NotSupportedException>(() => values[0] = "10px");
    }

    private static Dictionary<string, string> Fields() => new(StringComparer.Ordinal)
    {
        ["fontFamily"] = "system-sans",
        ["fontSize"] = "standard",
        ["lineHeight"] = "standard",
        ["canvasWidth"] = "standard",
        ["paragraphSpacing"] = "standard"
    };
}
