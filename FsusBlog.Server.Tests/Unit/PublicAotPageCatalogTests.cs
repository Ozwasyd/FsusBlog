using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotPageCatalogTests
{
    [Fact]
    public void TryGetByStaticPath_SpanLookup_IsCaseInsensitive()
    {
        bool found = PublicAotPageCatalog.TryGetByStaticPath("/ABOUT".AsSpan(), out PublicAotPageDescriptor descriptor);

        Assert.True(found);
        Assert.Equal(PublicPageKind.About, descriptor.Kind);
        Assert.Equal(PublicPageId.About, descriptor.PageId);
    }
}
