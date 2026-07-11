using System.Reflection;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests;

public sealed class CultureInvariantStringComparisonTests
{
    [Fact]
    public void BackendPathAndExtensionChecks_UseExplicitOrdinalComparisons()
    {
        Type[] types =
        [
            typeof(WebApplicationCompositionExtensions),
            typeof(FileService),
            typeof(SearchIndexService),
            typeof(SystemService),
            typeof(ModerationDictionaryService),
            typeof(ModerationRegionCatalogService),
            typeof(AuthoringWorkflowService)
        ];

        foreach (Type type in types)
        {
            IReadOnlyList<string> violations = RuntimeMetadataInspection.FindMethodsCallingMember(
                type,
                static member => member is MethodInfo method &&
                    method.DeclaringType == typeof(string) &&
                    method.Name is nameof(string.StartsWith) or nameof(string.EndsWith) &&
                    method.GetParameters().All(parameter => parameter.ParameterType != typeof(StringComparison)));
            Assert.True(violations.Count == 0, $"{type.FullName} uses culture-sensitive prefix/suffix calls: {string.Join(", ", violations)}");
        }

        string composition = RuntimeMetadataInspection.DescribeType(typeof(WebApplicationCompositionExtensions));
        foreach (string extension in new[] { ".js", ".css", ".wasm", ".woff", ".woff2", ".ttf", ".otf" })
        {
            Assert.Contains(extension, composition, StringComparison.Ordinal);
        }
        Assert.Contains("System.StringComparison", composition, StringComparison.Ordinal);
        Assert.Contains(nameof(StringComparison.OrdinalIgnoreCase), Enum.GetNames<StringComparison>());
    }
}
