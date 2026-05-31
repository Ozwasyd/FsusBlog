using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// PublicPageRegistry
// ──────────────────────────────────────────────────────────────────────────────

public class PublicPageRegistryTests
{
    [Fact]
    public void Home_HasCorrectProperties()
    {
        var home = PublicPageRegistry.Home;
        Assert.Equal(PublicPageId.Home, home.Id);
        Assert.Equal("home", home.CanonicalSlug);
        Assert.True(home.SeoEligible);
        Assert.True(home.AotShellReady);
        Assert.True(home.DeferSpaBoot);
    }

    [Fact]
    public void ArticleDetail_HasCorrectProperties()
    {
        var ad = PublicPageRegistry.ArticleDetail;
        Assert.Equal(PublicPageId.ArticleDetail, ad.Id);
        Assert.Equal("article", ad.CanonicalSlug);
        Assert.True(ad.SeoEligible);
        Assert.True(ad.AotShellReady);
    }

    [Fact]
    public void All_ContainsSixPages()
    {
        Assert.Equal(6, PublicPageRegistry.All.Length);
    }

    [Fact]
    public void All_IncludesAllPageIds()
    {
        var all = PublicPageRegistry.All;
        var ids = new HashSet<PublicPageId>(all.Select(p => p.Id));
        Assert.Equal(6, ids.Count);
        Assert.Contains(PublicPageId.Home, ids);
        Assert.Contains(PublicPageId.ArticleDetail, ids);
        Assert.Contains(PublicPageId.Archive, ids);
        Assert.Contains(PublicPageId.About, ids);
        Assert.Contains(PublicPageId.Account, ids);
        Assert.Contains(PublicPageId.Filter, ids);
    }

    [Fact]
    public void Account_SeoNotEligible()
    {
        var account = PublicPageRegistry.Account;
        Assert.False(account.SeoEligible);
    }

    [Fact]
    public void AllOthers_SeoEligible()
    {
        foreach (var page in PublicPageRegistry.All)
        {
            if (page.Id != PublicPageId.Account)
            {
                Assert.True(page.SeoEligible, $"{page.Id} should be SEO eligible");
            }
        }
    }
}
