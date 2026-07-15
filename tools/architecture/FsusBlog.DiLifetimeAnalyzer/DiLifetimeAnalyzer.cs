using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace FsusBlog.DiLifetimeAnalyzer;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class DiLifetimeAnalyzer : DiagnosticAnalyzer
{
    public const string CaptiveDependencyDiagnosticId = "FSUSDI001";

    private static readonly DiagnosticDescriptor CaptiveDependencyRule = new(
        CaptiveDependencyDiagnosticId,
        "Singleton captures a scoped dependency",
        "Singleton registration '{0}' captures scoped dependency through '{1}'",
        "DependencyInjection",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Singletons and hosted services must use IServiceScopeFactory instead of constructor-capturing scoped services.",
        customTags: new[] { WellKnownDiagnosticTags.CompilationEnd });

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics
        => ImmutableArray.Create(CaptiveDependencyRule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterCompilationStartAction(static startContext =>
        {
            var registrations = new ConcurrentBag<Registration>();
            startContext.RegisterSyntaxNodeAction(
                syntaxContext => CollectRegistration(syntaxContext, registrations),
                SyntaxKind.InvocationExpression);
            startContext.RegisterCompilationEndAction(
                compilationContext => AnalyzeGraph(compilationContext, registrations));
        });
    }

    private static void CollectRegistration(
        SyntaxNodeAnalysisContext context,
        ConcurrentBag<Registration> registrations)
    {
        var invocation = (InvocationExpressionSyntax)context.Node;
        SymbolInfo symbolInfo = context.SemanticModel.GetSymbolInfo(invocation, context.CancellationToken);
        IMethodSymbol? method = symbolInfo.Symbol as IMethodSymbol
            ?? symbolInfo.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        if (method is null)
        {
            return;
        }

        IMethodSymbol registrationMethod = method.ReducedFrom ?? method;
        if (registrationMethod.Parameters.Length == 0
            || registrationMethod.Parameters[0].Type.Name != "IServiceCollection"
            || registrationMethod.Parameters[0].Type.ContainingNamespace.ToDisplayString()
                != "Microsoft.Extensions.DependencyInjection")
        {
            return;
        }

        Lifetime? lifetime = GetLifetime(method.Name);
        bool hostedService = string.Equals(method.Name, "AddHostedService", StringComparison.Ordinal);
        if (lifetime is null && !hostedService)
        {
            return;
        }

        ImmutableArray<ITypeSymbol> typeArguments = method.TypeArguments;
        if (typeArguments.Length == 0)
        {
            return;
        }

        ITypeSymbol serviceType;
        ITypeSymbol implementationType;
        if (hostedService)
        {
            serviceType = typeArguments[0];
            implementationType = typeArguments[0];
            lifetime = Lifetime.Singleton;
        }
        else if (typeArguments.Length >= 2)
        {
            serviceType = typeArguments[0];
            implementationType = typeArguments[1];
        }
        else
        {
            serviceType = typeArguments[0];
            implementationType = typeArguments[0];
        }

        var factoryDependencies = new List<ITypeSymbol>();
        if (lifetime == Lifetime.Singleton)
        {
            foreach (InvocationExpressionSyntax nested in invocation.ArgumentList.Arguments
                         .SelectMany(static argument => argument.Expression.DescendantNodesAndSelf())
                         .OfType<InvocationExpressionSyntax>())
            {
                SymbolInfo nestedInfo = context.SemanticModel.GetSymbolInfo(nested, context.CancellationToken);
                IMethodSymbol? nestedMethod = nestedInfo.Symbol as IMethodSymbol;
                if (nestedMethod is not null
                    && nestedMethod.TypeArguments.Length == 1
                    && (nestedMethod.Name == "GetRequiredService" || nestedMethod.Name == "GetService"))
                {
                    factoryDependencies.Add(nestedMethod.TypeArguments[0]);
                }
            }
        }

        registrations.Add(new Registration(
            serviceType,
            implementationType,
            lifetime!.Value,
            invocation.GetLocation(),
            factoryDependencies.ToImmutableArray()));
    }

    private static void AnalyzeGraph(
        CompilationAnalysisContext context,
        IEnumerable<Registration> registrationSource)
    {
        Registration[] registrations = registrationSource
            .OrderBy(static registration => registration.Location.SourceTree?.FilePath ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(static registration => registration.Location.SourceSpan.Start)
            .ToArray();
        var byService = new Dictionary<ITypeSymbol, List<Registration>>(SymbolEqualityComparer.Default);
        for (int i = 0; i < registrations.Length; i++)
        {
            Registration registration = registrations[i];
            if (!byService.TryGetValue(registration.ServiceType, out List<Registration>? values))
            {
                values = new List<Registration>();
                byService.Add(registration.ServiceType, values);
            }

            values.Add(registration);
        }

        foreach (Registration root in registrations.Where(static registration => registration.Lifetime == Lifetime.Singleton))
        {
            string? captivePath = FindCaptivePath(root, byService);
            if (captivePath is null)
            {
                continue;
            }

            context.ReportDiagnostic(Diagnostic.Create(
                CaptiveDependencyRule,
                root.Location,
                root.ImplementationType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                captivePath));
        }
    }

    private static string? FindCaptivePath(
        Registration root,
        IReadOnlyDictionary<ITypeSymbol, List<Registration>> byService)
    {
        var path = new List<ITypeSymbol> { root.ImplementationType };
        var visiting = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
        return VisitRegistration(root, byService, path, visiting);
    }

    private static string? VisitRegistration(
        Registration registration,
        IReadOnlyDictionary<ITypeSymbol, List<Registration>> byService,
        List<ITypeSymbol> path,
        HashSet<ITypeSymbol> visiting)
    {
        if (!visiting.Add(registration.ImplementationType))
        {
            return null;
        }

        try
        {
            for (int i = 0; i < registration.FactoryDependencies.Length; i++)
            {
                string? factoryPath = VisitDependency(
                    registration.FactoryDependencies[i],
                    includeEveryRegistration: false,
                    byService,
                    path,
                    visiting);
                if (factoryPath is not null)
                {
                    return factoryPath;
                }
            }

            return VisitImplementation(registration.ImplementationType, byService, path, visiting);
        }
        finally
        {
            visiting.Remove(registration.ImplementationType);
        }
    }

    private static string? VisitImplementation(
        ITypeSymbol implementationType,
        IReadOnlyDictionary<ITypeSymbol, List<Registration>> byService,
        List<ITypeSymbol> path,
        HashSet<ITypeSymbol> visiting)
    {
        if (implementationType is not INamedTypeSymbol namedType)
        {
            return null;
        }

        IMethodSymbol? constructor = namedType.InstanceConstructors
            .Where(static candidate => !candidate.IsStatic && candidate.DeclaredAccessibility == Accessibility.Public)
            .OrderByDescending(static candidate => candidate.Parameters.Length)
            .FirstOrDefault();
        if (constructor is null)
        {
            return null;
        }

        foreach (IParameterSymbol parameter in constructor.Parameters)
        {
            ITypeSymbol dependency = parameter.Type;
            if (IsScopeBoundary(dependency))
            {
                continue;
            }

            bool includeEveryRegistration = false;
            if (dependency is INamedTypeSymbol enumerable
                && enumerable.IsGenericType
                && enumerable.Name == "IEnumerable"
                && enumerable.TypeArguments.Length == 1)
            {
                dependency = enumerable.TypeArguments[0];
                includeEveryRegistration = true;
            }

            string? nested = VisitDependency(
                dependency,
                includeEveryRegistration,
                byService,
                path,
                visiting);
            if (nested is not null)
            {
                return nested;
            }
        }

        return null;
    }

    private static string? VisitDependency(
        ITypeSymbol dependency,
        bool includeEveryRegistration,
        IReadOnlyDictionary<ITypeSymbol, List<Registration>> byService,
        List<ITypeSymbol> path,
        HashSet<ITypeSymbol> visiting)
    {
        if (IsScopeBoundary(dependency)
            || !byService.TryGetValue(dependency, out List<Registration>? registrations)
            || registrations.Count == 0)
        {
            return null;
        }

        int first = includeEveryRegistration ? 0 : registrations.Count - 1;
        for (int i = first; i < registrations.Count; i++)
        {
            Registration registration = registrations[i];
            if (registration.Lifetime == Lifetime.Scoped)
            {
                return FormatPath(path, dependency);
            }

            path.Add(registration.ImplementationType);
            string? nested = VisitRegistration(registration, byService, path, visiting);
            path.RemoveAt(path.Count - 1);
            if (nested is not null)
            {
                return nested;
            }
        }

        return null;
    }

    private static bool IsScopeBoundary(ITypeSymbol type)
        => (type.Name == "IServiceProvider" && type.ContainingNamespace.ToDisplayString() == "System")
            || (type.Name == "IServiceScopeFactory"
                && type.ContainingNamespace.ToDisplayString() == "Microsoft.Extensions.DependencyInjection");

    private static string FormatPath(IReadOnlyList<ITypeSymbol> path, ITypeSymbol scopedDependency)
        => string.Join(
            " -> ",
            path.Select(static type => type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat))
                .Concat(new[] { scopedDependency.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) }));

    private static Lifetime? GetLifetime(string methodName)
        => methodName switch
        {
            "AddSingleton" or "TryAddSingleton" => Lifetime.Singleton,
            "AddScoped" or "TryAddScoped" => Lifetime.Scoped,
            "AddTransient" or "TryAddTransient" => Lifetime.Transient,
            _ => null
        };

    private enum Lifetime
    {
        Singleton,
        Scoped,
        Transient
    }

    private sealed class Registration
    {
        public Registration(
            ITypeSymbol serviceType,
            ITypeSymbol implementationType,
            Lifetime lifetime,
            Location location,
            ImmutableArray<ITypeSymbol> factoryDependencies)
        {
            ServiceType = serviceType;
            ImplementationType = implementationType;
            Lifetime = lifetime;
            Location = location;
            FactoryDependencies = factoryDependencies;
        }

        public ITypeSymbol ServiceType { get; }
        public ITypeSymbol ImplementationType { get; }
        public Lifetime Lifetime { get; }
        public Location Location { get; }
        public ImmutableArray<ITypeSymbol> FactoryDependencies { get; }
    }
}
