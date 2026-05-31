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

        PublicPageKind[] actualKinds = PublicAotPageCatalog.All
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
        foreach (PublicAotPageDescriptor descriptor in PublicAotPageCatalog.All)
        {
            PublicPageDescriptor shared = PublicPageRegistry.GetRequired(descriptor.PageId);

            Assert.Equal(shared.Id.ToString(), descriptor.HydrationKind);

            if (descriptor.Kind is PublicPageKind.Home or PublicPageKind.About or PublicPageKind.Archive or PublicPageKind.Account)
            {
                Assert.Equal(shared.CanonicalSlug, descriptor.FixedRouteKey);
            }
        }

        Assert.Equal(PublicRouteIdentityRegistry.AccountPath, PublicAotPageCatalog.Account.CanonicalFixedPath);
    }
}
