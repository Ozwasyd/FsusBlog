using System.Collections.ObjectModel;
using System.Diagnostics.Metrics;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed record DependencyGraphRuntimeSnapshot(
    int RegistrationCount,
    int SingletonCount,
    int ScopedCount,
    int TransientCount,
    int HostedServiceCount,
    int OpaqueFactoryCount,
    IReadOnlyList<string> CaptiveDependencies)
{
    public static DependencyGraphRuntimeSnapshot Empty
    {
        get;
    } = new(
        0,
        0,
        0,
        0,
        0,
        0,
        Array.Empty<string>());
}

public sealed class DependencyGraphRuntimeState
{
    private static readonly Meter s_meter = new(FsusObservability.MeterName, FsusObservability.ServiceVersion);
    private static long s_registrationCount;
    private static long s_captiveDependencyCount;
    private static long s_opaqueFactoryCount;

    private static readonly ObservableGauge<long> s_registrationCountGauge = s_meter.CreateObservableGauge(
        "fsus.di.graph.registration_count",
        static () => Volatile.Read(ref s_registrationCount),
        "{registration}");

    private static readonly ObservableGauge<long> s_captiveDependencyCountGauge = s_meter.CreateObservableGauge(
        "fsus.di.graph.captive_dependency_count",
        static () => Volatile.Read(ref s_captiveDependencyCount),
        "{dependency}");

    private static readonly ObservableGauge<long> s_opaqueFactoryCountGauge = s_meter.CreateObservableGauge(
        "fsus.di.graph.opaque_factory_count",
        static () => Volatile.Read(ref s_opaqueFactoryCount),
        "{registration}");

    private DependencyGraphRuntimeSnapshot _snapshot = DependencyGraphRuntimeSnapshot.Empty;

    public DependencyGraphRuntimeSnapshot Snapshot => Volatile.Read(ref _snapshot);

    internal void Publish(DependencyGraphRuntimeSnapshot snapshot)
    {
        Volatile.Write(ref _snapshot, snapshot);
        Volatile.Write(ref s_registrationCount, snapshot.RegistrationCount);
        Volatile.Write(ref s_captiveDependencyCount, snapshot.CaptiveDependencies.Count);
        Volatile.Write(ref s_opaqueFactoryCount, snapshot.OpaqueFactoryCount);
    }
}

public static class DependencyGraphValidationExtensions
{
    public static IServiceCollection AddFsusDependencyGraphValidation(this IServiceCollection services)
    {
        services.TryAddSingleton<DependencyGraphRuntimeState>();
        return services;
    }

    public static IServiceCollection ValidateAndPublishFsusDependencyGraph(this IServiceCollection services)
    {
        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);
        if (snapshot.CaptiveDependencies.Count > 0)
        {
            throw new InvalidOperationException(
                $"DI lifetime validation failed: {string.Join("; ", snapshot.CaptiveDependencies)}");
        }

        ServiceDescriptor[] previous = services
            .Where(static descriptor => descriptor.ServiceType == typeof(DependencyGraphRuntimeState))
            .ToArray();
        for (int i = 0; i < previous.Length; i++)
        {
            services.Remove(previous[i]);
        }

        var state = new DependencyGraphRuntimeState();
        state.Publish(snapshot);
        services.AddSingleton(state);
        return services;
    }
}

public static class FsusServiceProviderValidation
{
    public static void Configure(ServiceProviderOptions options)
    {
        options.ValidateScopes = true;
        options.ValidateOnBuild = true;
    }
}

internal static class DependencyGraphValidator
{
    private static readonly Type s_enumerableType = typeof(IEnumerable<>);
    private static readonly Type s_serviceProviderType = typeof(IServiceProvider);
    private static readonly Type s_scopeFactoryType = typeof(IServiceScopeFactory);

    public static DependencyGraphRuntimeSnapshot Analyze(IList<ServiceDescriptor> services)
    {
        Dictionary<Type, List<ServiceDescriptor>> registrations = BuildRegistrationMap(services);
        var violations = new SortedSet<string>(StringComparer.Ordinal);
        int singletonCount = 0;
        int scopedCount = 0;
        int transientCount = 0;
        int hostedServiceCount = 0;
        int opaqueFactoryCount = 0;

        for (int i = 0; i < services.Count; i++)
        {
            ServiceDescriptor descriptor = services[i];
            switch (descriptor.Lifetime)
            {
                case ServiceLifetime.Singleton:
                    singletonCount++;
                    break;
                case ServiceLifetime.Scoped:
                    scopedCount++;
                    break;
                case ServiceLifetime.Transient:
                    transientCount++;
                    break;
            }

            if (descriptor.ServiceType == typeof(IHostedService))
            {
                hostedServiceCount++;
            }

            if (descriptor.IsKeyedService || (!descriptor.IsKeyedService && descriptor.ImplementationFactory is not null))
            {
                opaqueFactoryCount++;
            }

            if (descriptor.Lifetime != ServiceLifetime.Singleton)
            {
                continue;
            }

            Type? implementationType = GetImplementationType(descriptor);
            if (implementationType is null)
            {
                continue;
            }

            var path = new List<Type> { implementationType };
            var visiting = new HashSet<Type>();
            VisitImplementation(implementationType, registrations, path, visiting, violations);
        }

        return new DependencyGraphRuntimeSnapshot(
            services.Count,
            singletonCount,
            scopedCount,
            transientCount,
            hostedServiceCount,
            opaqueFactoryCount,
            new ReadOnlyCollection<string>(violations.ToArray()));
    }

    private static Dictionary<Type, List<ServiceDescriptor>> BuildRegistrationMap(IList<ServiceDescriptor> services)
    {
        var registrations = new Dictionary<Type, List<ServiceDescriptor>>();
        for (int i = 0; i < services.Count; i++)
        {
            ServiceDescriptor descriptor = services[i];
            if (descriptor.IsKeyedService)
            {
                continue;
            }

            if (!registrations.TryGetValue(descriptor.ServiceType, out List<ServiceDescriptor>? descriptors))
            {
                descriptors = [];
                registrations.Add(descriptor.ServiceType, descriptors);
            }

            descriptors.Add(descriptor);
        }

        return registrations;
    }

    private static void VisitImplementation(
        Type implementationType,
        IReadOnlyDictionary<Type, List<ServiceDescriptor>> registrations,
        List<Type> path,
        HashSet<Type> visiting,
        ISet<string> violations)
    {
        if (!visiting.Add(implementationType))
        {
            return;
        }

        try
        {
            ConstructorInfo? constructor = implementationType
                .GetConstructors(BindingFlags.Instance | BindingFlags.Public)
                .OrderByDescending(static candidate => candidate.GetParameters().Length)
                .FirstOrDefault();
            if (constructor is null)
            {
                return;
            }

            ParameterInfo[] parameters = constructor.GetParameters();
            for (int i = 0; i < parameters.Length; i++)
            {
                VisitDependency(parameters[i].ParameterType, registrations, path, visiting, violations);
            }
        }
        finally
        {
            visiting.Remove(implementationType);
        }
    }

    private static void VisitDependency(
        Type dependencyType,
        IReadOnlyDictionary<Type, List<ServiceDescriptor>> registrations,
        List<Type> path,
        HashSet<Type> visiting,
        ISet<string> violations)
    {
        if (dependencyType == s_serviceProviderType || dependencyType == s_scopeFactoryType)
        {
            return;
        }

        if (dependencyType.IsGenericType && dependencyType.GetGenericTypeDefinition() == s_enumerableType)
        {
            Type elementType = dependencyType.GetGenericArguments()[0];
            if (registrations.TryGetValue(elementType, out List<ServiceDescriptor>? enumerableDescriptors))
            {
                for (int i = 0; i < enumerableDescriptors.Count; i++)
                {
                    VisitDescriptor(elementType, enumerableDescriptors[i], registrations, path, visiting, violations);
                }
            }

            return;
        }

        if (registrations.TryGetValue(dependencyType, out List<ServiceDescriptor>? descriptors))
        {
            VisitDescriptor(dependencyType, descriptors[^1], registrations, path, visiting, violations);
            return;
        }

        if (dependencyType.IsClass && dependencyType.Assembly == typeof(DependencyGraphValidator).Assembly)
        {
            path.Add(dependencyType);
            VisitImplementation(dependencyType, registrations, path, visiting, violations);
            path.RemoveAt(path.Count - 1);
        }
    }

    private static void VisitDescriptor(
        Type dependencyType,
        ServiceDescriptor descriptor,
        IReadOnlyDictionary<Type, List<ServiceDescriptor>> registrations,
        List<Type> path,
        HashSet<Type> visiting,
        ISet<string> violations)
    {
        if (descriptor.Lifetime == ServiceLifetime.Scoped)
        {
            violations.Add(FormatPath(path, dependencyType));
            return;
        }

        Type? implementationType = GetImplementationType(descriptor);
        if (implementationType is null)
        {
            return;
        }

        path.Add(implementationType);
        VisitImplementation(implementationType, registrations, path, visiting, violations);
        path.RemoveAt(path.Count - 1);
    }

    private static Type? GetImplementationType(ServiceDescriptor descriptor)
        => descriptor.IsKeyedService ? descriptor.KeyedImplementationType : descriptor.ImplementationType;

    private static string FormatPath(IReadOnlyList<Type> path, Type scopedType)
        => string.Join(" -> ", path.Select(static type => type.FullName ?? type.Name).Append(scopedType.FullName ?? scopedType.Name));
}
