using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicSiteIdentityDefaultsTests
{
    [Fact]
    public void SeoConfigDefaults_AreSharedAcrossBackendAndContractModels()
    {
        var publicDto = new SeoConfigPublicDto();
        var adminDto = new SeoConfigAdminDto();
        var readModel = new SeoConfigReadModel();
        var request = new UpdateSeoConfigRequest();

        Assert.Equal(PublicSiteIdentityDefaults.SiteTitle, publicDto.Title);
        Assert.Equal(PublicSiteIdentityDefaults.SiteDescription, publicDto.Description);
        Assert.Equal(PublicSiteIdentityDefaults.SiteKeywords, publicDto.Keywords);
        Assert.Equal(PublicSiteIdentityDefaults.SiteAuthor, publicDto.Author);
        Assert.Equal(PublicSiteIdentityDefaults.ManifestName, publicDto.ManifestName);
        Assert.Equal(PublicSiteIdentityDefaults.ManifestShortName, publicDto.ManifestShortName);

        Assert.Equal(publicDto.Title, adminDto.Title);
        Assert.Equal(publicDto.Description, adminDto.Description);
        Assert.Equal(publicDto.Keywords, adminDto.Keywords);
        Assert.Equal(publicDto.Author, adminDto.Author);
        Assert.Equal(publicDto.ManifestName, adminDto.ManifestName);
        Assert.Equal(publicDto.ManifestShortName, adminDto.ManifestShortName);

        Assert.Equal(publicDto.Title, readModel.Title);
        Assert.Equal(publicDto.Description, readModel.Description);
        Assert.Equal(publicDto.Keywords, readModel.Keywords);
        Assert.Equal(publicDto.Author, readModel.Author);
        Assert.Equal(publicDto.ManifestName, readModel.ManifestName);
        Assert.Equal(publicDto.ManifestShortName, readModel.ManifestShortName);

        Assert.Equal(publicDto.Title, request.Title);
        Assert.Equal(publicDto.Description, request.Description);
        Assert.Equal(publicDto.Keywords, request.Keywords);
        Assert.Equal(publicDto.Author, request.Author);
        Assert.Equal(publicDto.ManifestName, request.ManifestName);
        Assert.Equal(publicDto.ManifestShortName, request.ManifestShortName);
    }
}
