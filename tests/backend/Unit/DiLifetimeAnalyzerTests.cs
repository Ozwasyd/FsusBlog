using System.Collections.Immutable;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

using AnalyzerUnderTest = FsusBlog.DiLifetimeAnalyzer.DiLifetimeAnalyzer;

namespace FsusBlog.Server.Tests;

public sealed class DiLifetimeAnalyzerTests
{
    [Fact]
    public async Task Analyzer_RejectsSingletonChainThatCapturesScopedService()
    {
        const string Registrations = """
            services.AddScoped<IScopedDependency, ScopedDependency>();
            services.AddSingleton<ISingletonBridge, SingletonBridge>();
            services.AddSingleton<SingletonRoot>();
            """;
        const string Declarations = """
            public interface IScopedDependency { }
            public sealed class ScopedDependency : IScopedDependency { }
            public interface ISingletonBridge { }
            public sealed class SingletonBridge(IScopedDependency dependency) : ISingletonBridge { }
            public sealed class SingletonRoot(ISingletonBridge bridge) { }
            """;

        ImmutableArray<Diagnostic> diagnostics = await AnalyzeAsync(Registrations, Declarations);
        Diagnostic diagnostic = Assert.Single(
            diagnostics,
            static candidate => candidate.GetMessage().Contains("SingletonRoot", StringComparison.Ordinal));

        Assert.Equal(AnalyzerUnderTest.CaptiveDependencyDiagnosticId, diagnostic.Id);
        Assert.Contains("SingletonRoot", diagnostic.GetMessage(), StringComparison.Ordinal);
        Assert.Contains("IScopedDependency", diagnostic.GetMessage(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Analyzer_RejectsScopedRegistrationInsideMixedEnumerable()
    {
        const string Registrations = """
            services.AddSingleton<IParticipant, SingletonParticipant>();
            services.AddScoped<IParticipant, ScopedParticipant>();
            services.AddSingleton<EnumerableRoot>();
            """;
        const string Declarations = """
            public interface IParticipant { }
            public sealed class SingletonParticipant : IParticipant { }
            public sealed class ScopedParticipant : IParticipant { }
            public sealed class EnumerableRoot(System.Collections.Generic.IEnumerable<IParticipant> participants) { }
            """;

        Diagnostic diagnostic = Assert.Single(await AnalyzeAsync(Registrations, Declarations));

        Assert.Equal(AnalyzerUnderTest.CaptiveDependencyDiagnosticId, diagnostic.Id);
        Assert.Contains("EnumerableRoot", diagnostic.GetMessage(), StringComparison.Ordinal);
        Assert.Contains("IParticipant", diagnostic.GetMessage(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Analyzer_UsesLastRegistrationForNonEnumerableResolution()
    {
        const string Registrations = """
            services.AddScoped<IDependency, ScopedDependency>();
            services.AddSingleton<IDependency, SingletonDependency>();
            services.AddSingleton<SingletonRoot>();
            """;
        const string Declarations = """
            public interface IDependency { }
            public sealed class ScopedDependency : IDependency { }
            public sealed class SingletonDependency : IDependency { }
            public sealed class SingletonRoot(IDependency dependency) { }
            """;

        Assert.Empty(await AnalyzeAsync(Registrations, Declarations));
    }

    private static async Task<ImmutableArray<Diagnostic>> AnalyzeAsync(
        string registrations,
        string declarations)
    {
        string source = $$"""
            using Microsoft.Extensions.DependencyInjection;

            public static class Composition
            {
                public static void Register(IServiceCollection services)
                {
                    {{registrations}}
                }
            }

            {{declarations}}

            namespace Microsoft.Extensions.DependencyInjection
            {
                public interface IServiceCollection { }

                public static class ServiceCollectionServiceExtensions
                {
                    public static IServiceCollection AddSingleton<TService>(this IServiceCollection services) => services;
                    public static IServiceCollection AddSingleton<TService, TImplementation>(this IServiceCollection services) where TImplementation : TService => services;
                    public static IServiceCollection AddScoped<TService, TImplementation>(this IServiceCollection services) where TImplementation : TService => services;
                    public static IServiceCollection AddTransient<TService, TImplementation>(this IServiceCollection services) where TImplementation : TService => services;
                }
            }
            """;

        CSharpCompilation compilation = CSharpCompilation.Create(
            "DiLifetimeAnalyzerFixture",
            [CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp13))],
            s_trustedPlatformReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        ImmutableArray<Diagnostic> compilerDiagnostics = compilation.GetDiagnostics();
        Assert.DoesNotContain(compilerDiagnostics, static diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        return await compilation
            .WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new AnalyzerUnderTest()))
            .GetAnalyzerDiagnosticsAsync();
    }

    private static readonly MetadataReference[] s_trustedPlatformReferences =
        ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")
            ?? throw new InvalidOperationException("Trusted platform assemblies are unavailable."))
        .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        .Select(static path => MetadataReference.CreateFromFile(path))
        .ToArray();
}
