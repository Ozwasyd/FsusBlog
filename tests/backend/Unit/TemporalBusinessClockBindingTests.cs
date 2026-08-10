using System.Reflection;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TemporalBusinessClockBindingTests
{
    [Theory]
    [InlineData(typeof(PublicHotArtifactProjector))]
    [InlineData(typeof(ArticleDetailAedsArtifactProjector))]
    [InlineData(typeof(ArticleDetailAedsArtifactMaintenanceService))]
    public void CorrectnessProjector_UsesInjectedBusinessClock(Type runtimeType)
    {
        Assert.Contains(
            runtimeType.GetConstructors().SelectMany(static constructor => constructor.GetParameters()),
            static parameter => parameter.ParameterType == typeof(TimeProvider));

        IReadOnlyList<string> staticWallClockCallers =
            RuntimeMetadataInspection.FindMethodsCallingMember(
                runtimeType,
                static member =>
                    member.Name == "get_UtcNow"
                    && member.DeclaringType is not null
                    && (member.DeclaringType == typeof(DateTime)
                        || member.DeclaringType == typeof(DateTimeOffset)));
        Assert.Empty(staticWallClockCallers);
    }

    [Fact]
    public void PublicContentFixture_UpdateRequestCarriesCurrentRevision()
    {
        MethodInfo builder = typeof(PublicContentFixtureSeeder).GetMethod(
            "BuildWriteRequest",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("fixture write-request builder is missing");
        var request = Assert.IsType<ArticleWriteRequestCoreModel>(builder.Invoke(
            null,
            [
                "title",
                "body",
                "summary",
                null,
                7,
                11,
                ArticleStatus.Published,
                null,
                42L
            ]));

        Assert.Equal(42L, request.BaseRevisionId);
        string runtime = RuntimeMetadataInspection.DescribeType(typeof(PublicContentFixtureSeeder));
        Assert.Contains("RequireCurrentRevisionIdAsync", runtime, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicContentFixture_RevisionHistoryAppendix_PassesContentSafetyFilter()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-public-content-fixture-{Guid.NewGuid():N}");
        try
        {
            using var filter = new ContentFilterService(
                new ContentFilterTestEnvironment(root),
                NullLogger<ContentFilterService>.Instance);

            var result = filter.ValidateContent(
                "# Fixture Primary\n\nSearchable token FXPC_PRIMARY_BODY."
                + PublicContentFixtureSeeder.RevisionHistoryFixtureAppendix);

            Assert.True(result.IsValid, $"{result.ReasonCode}: {result.Message}");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class ContentFilterTestEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(TemporalBusinessClockBindingTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

}
