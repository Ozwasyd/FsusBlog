using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotPageCatalogTests
{
    [Fact]
    public void Catalog_CoversAllNonUnknownKinds()
    {
        PublicPageKind[] expectedKinds = Enum.GetValues<PublicPageKind>()
            .Where(static kind => kind != PublicPageKind.Unknown)
            .OrderBy(static kind => kind)
            .ToArray();

        PublicPageKind[] actualKinds = PublicAotPageCatalog.s_all
            .Select(static descriptor => descriptor.Kind)
            .OrderBy(static kind => kind)
            .ToArray();

        Assert.Equal(expectedKinds, actualKinds);
    }

    [Fact]
    public void TryGetByStaticPath_SpanLookup_IsCaseInsensitive()
    {
        bool found = PublicAotPageCatalog.TryGetByStaticPath("/ABOUT".AsSpan(), out PublicAotPageDescriptor descriptor);

        Assert.True(found);
        Assert.Equal(PublicPageKind.About, descriptor.Kind);
        Assert.Equal(PublicPageId.About, descriptor.PageId);
    }

    [Fact]
    public void Catalog_DerivedIdentity_StaysAlignedWithSharedRegistry()
    {
        foreach (PublicAotPageDescriptor descriptor in PublicAotPageCatalog.s_all)
        {
            PublicPageDescriptor shared = PublicPageRegistry.GetRequired(descriptor.PageId);

            Assert.Equal(shared.Id.ToString(), descriptor.HydrationKind);
            Assert.Equal(shared.SeoEligible, descriptor.SeoEligible);
            Assert.Equal(shared.AotShellReady, descriptor.AotShellReady);
            Assert.Equal(shared.RequiresUserState, descriptor.RequiresUserState);
            Assert.Equal(shared.FallbackBehavior, descriptor.FallbackBehavior);

            if (descriptor.Kind is PublicPageKind.Home
                or PublicPageKind.About
                or PublicPageKind.Archive
                or PublicPageKind.Privacy
                or PublicPageKind.Guidelines
                or PublicPageKind.Copyright
                or PublicPageKind.Account)
            {
                Assert.Equal(shared.CanonicalSlug, descriptor.FixedRouteKey);
            }
        }

        Assert.Equal(PublicRouteIdentityRegistry.AccountPath, PublicAotPageCatalog.Account.CanonicalFixedPath);
        Assert.False(PublicAotPageCatalog.Account.AotShellReady);
        Assert.True(PublicAotPageCatalog.Account.RequiresUserState);
    }
}
