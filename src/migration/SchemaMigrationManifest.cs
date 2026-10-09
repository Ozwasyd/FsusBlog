using FsusBlog.Migration.Catalogs;

namespace FsusBlog.Migration;

internal sealed class SchemaMigrationManifest
{
    private SchemaMigrationManifest(
        IReadOnlyList<SchemaMigrationCatalog> catalogs,
        IReadOnlyList<SchemaMigrationVersionGap> declaredVersionGaps,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        Catalogs = catalogs;
        DeclaredVersionGaps = declaredVersionGaps;
        Descriptors = descriptors;
    }

    internal static SchemaMigrationManifest Current
    {
        get;
    } = Create(
        [
            SchemaMigrationCatalog20260418To20260518.Create(),
            SchemaMigrationCatalog20260602To20260621.Create(),
            SchemaMigrationCatalog20260625To20260704.Create(),
            SchemaMigrationCatalog20260709To20260716.Create(),
            SchemaMigrationCatalog20260719.Create(),
            SchemaMigrationCatalog20260720.Create(),
            SchemaMigrationCatalog20260724.Create(),
            SchemaMigrationCatalog20260725.Create(),
            SchemaMigrationCatalog20260726.Create(),
            SchemaMigrationCatalog20260727.Create(),
            SchemaMigrationCatalog20260728.Create(),
            SchemaMigrationCatalog20260809.Create(),
            SchemaMigrationCatalog20260826.Create(),
            SchemaMigrationCatalog20260828.Create(),
            SchemaMigrationCatalog20260829.Create(),
            Create20260904Catalog(),
            SchemaMigrationCatalog20260905ArticleTemplates.Create(),
            SchemaMigrationCatalog20260906AuthoringCanvasOperations.Create(),
            SchemaMigrationCatalog20260907.Create(),
            SchemaMigrationCatalog20260908ArticleCreate.Create(),
            SchemaMigrationCatalog20260913BanStateProjection.Create(),
            Create20260915Catalog(),
            SchemaMigrationCatalog20261002ArticlePropertyDefinitionCommandHistory.Create(),
            SchemaMigrationCatalog20261006ArticleCanvasLinks.Create(),
            Create20261008Catalog()
        ],
        [
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 5, 19),
                new DateOnly(2026, 6, 1)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 6, 22),
                new DateOnly(2026, 6, 24)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 7, 5),
                new DateOnly(2026, 7, 8)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 7, 17),
                new DateOnly(2026, 7, 18)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 7, 21),
                new DateOnly(2026, 7, 23)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 7, 29),
                new DateOnly(2026, 8, 8)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 8, 10),
                new DateOnly(2026, 8, 25)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 8, 27),
                new DateOnly(2026, 8, 27)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 8, 30),
                new DateOnly(2026, 9, 3)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 9, 9),
                new DateOnly(2026, 9, 12)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 9, 14),
                new DateOnly(2026, 9, 14)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 9, 16),
                new DateOnly(2026, 10, 1)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 10, 3),
                new DateOnly(2026, 10, 5)),
            new SchemaMigrationVersionGap(
                new DateOnly(2026, 10, 7),
                new DateOnly(2026, 10, 7))
        ]);

    private static SchemaMigrationCatalog Create20260904Catalog()
    {
        SchemaMigrationCatalog[] catalogs =
        [
            SchemaMigrationCatalog20260904.Create(),
            SchemaMigrationCatalog20260904SavedViews.Create()
        ];
        return new SchemaMigrationCatalog(
            CatalogId: "current-20260904-authoring",
            StartVersion: new DateOnly(2026, 9, 4),
            EndVersion: new DateOnly(2026, 9, 4),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Dependencies)
                    .Distinct()
                    .OrderBy(static dependency => dependency.MigrationId, StringComparer.Ordinal)
                    .ThenBy(static dependency => dependency.Phase)
            ]),
            Descriptors: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Descriptors)
                    .Order(SchemaMigrationExecutionOrder.Instance)
            ]));
    }

    private static SchemaMigrationCatalog Create20260915Catalog()
    {
        SchemaMigrationCatalog[] catalogs =
        [
            SchemaMigrationCatalog20260915AuthorRecentHistory.Create(),
            SchemaMigrationCatalog20260915ArticlePropertyDefinitions.Create()
        ];
        return new SchemaMigrationCatalog(
            CatalogId: "current-20260915-authoring",
            StartVersion: new DateOnly(2026, 9, 15),
            EndVersion: new DateOnly(2026, 9, 15),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Dependencies)
                    .Distinct()
                    .OrderBy(static dependency => dependency.MigrationId, StringComparer.Ordinal)
                    .ThenBy(static dependency => dependency.Phase)
            ]),
            Descriptors: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Descriptors)
                    .Order(SchemaMigrationExecutionOrder.Instance)
            ]));
    }

    private static SchemaMigrationCatalog Create20261008Catalog()
    {
        SchemaMigrationCatalog[] catalogs =
        [
            SchemaMigrationCatalog20261008ArticlePropertyValues.Create(),
            SchemaMigrationCatalog20261008AuthoringWorkspaceSnapshot.Create(),
            SchemaMigrationCatalog20261008WritingAidPreferences.Create()
        ];
        return new SchemaMigrationCatalog(
            CatalogId: "current-20261008-authoring",
            StartVersion: new DateOnly(2026, 10, 8),
            EndVersion: new DateOnly(2026, 10, 8),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Dependencies)
                    .Distinct()
                    .OrderBy(static dependency => dependency.MigrationId, StringComparer.Ordinal)
                    .ThenBy(static dependency => dependency.Phase)
            ]),
            Descriptors: Array.AsReadOnly(
            [
                .. catalogs.SelectMany(static catalog => catalog.Descriptors)
                    .Order(SchemaMigrationExecutionOrder.Instance)
            ]));
    }

    internal IReadOnlyList<SchemaMigrationCatalog> Catalogs
    {
        get;
    }

    internal IReadOnlyList<SchemaMigrationVersionGap> DeclaredVersionGaps
    {
        get;
    }

    internal IReadOnlyList<ISchemaMigrationDescriptor> Descriptors
    {
        get;
    }

    internal static SchemaMigrationManifest Create(
        IReadOnlyList<SchemaMigrationCatalog> catalogs,
        IReadOnlyList<SchemaMigrationVersionGap> declaredVersionGaps)
    {
        ArgumentNullException.ThrowIfNull(catalogs);
        ArgumentNullException.ThrowIfNull(declaredVersionGaps);

        SchemaMigrationCatalog[] catalogSnapshot =
        [
            .. catalogs.Select(static catalog => catalog with
            {
                Dependencies = Array.AsReadOnly<SchemaMigrationCatalogDependency>([.. catalog.Dependencies]),
                Descriptors = Array.AsReadOnly<ISchemaMigrationDescriptor>([.. catalog.Descriptors])
            })
        ];
        SchemaMigrationVersionGap[] gapSnapshot = [.. declaredVersionGaps];
        ISchemaMigrationDescriptor[] declaredDescriptors =
        [
            .. catalogSnapshot.SelectMany(static catalog => catalog.Descriptors)
        ];

        ValidateUniqueMigrationIds(declaredDescriptors);
        ValidateCatalogs(catalogSnapshot);
        ValidateVersionGaps(catalogSnapshot, gapSnapshot);
        ValidateDependencies(catalogSnapshot);

        ISchemaMigrationDescriptor[] descriptors =
        [
            .. declaredDescriptors.Order(SchemaMigrationExecutionOrder.Instance)
        ];
        ValidateExecutionOrder(descriptors);

        return new SchemaMigrationManifest(
            Array.AsReadOnly(catalogSnapshot),
            Array.AsReadOnly(gapSnapshot),
            Array.AsReadOnly(descriptors));
    }

    internal static void ValidateExecutionOrder(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        ArgumentNullException.ThrowIfNull(descriptors);

        ValidateUniqueMigrationIds(descriptors);
        for (int index = 1; index < descriptors.Count; index++)
        {
            ISchemaMigrationDescriptor previous = descriptors[index - 1];
            ISchemaMigrationDescriptor current = descriptors[index];
            if (SchemaMigrationExecutionOrder.Instance.Compare(previous, current) >= 0)
            {
                throw new InvalidOperationException(
                    $"Schema migration execution order is not monotonic at {previous.MigrationId} -> {current.MigrationId}.");
            }
        }
    }

    private static void ValidateCatalogs(IReadOnlyList<SchemaMigrationCatalog> catalogs)
    {
        if (catalogs.Count == 0)
        {
            throw new InvalidOperationException("Schema migration manifest must contain at least one catalog.");
        }

        string[] duplicateCatalogIds =
        [
            .. catalogs
                .GroupBy(static catalog => catalog.CatalogId, StringComparer.Ordinal)
                .Where(static group => group.Count() > 1)
                .Select(static group => group.Key)
                .Order(StringComparer.Ordinal)
        ];
        if (duplicateCatalogIds.Length > 0)
        {
            throw new InvalidOperationException(
                $"Duplicate schema migration catalog ids found: {string.Join(", ", duplicateCatalogIds)}");
        }

        for (int catalogIndex = 0; catalogIndex < catalogs.Count; catalogIndex++)
        {
            SchemaMigrationCatalog catalog = catalogs[catalogIndex];
            if (string.IsNullOrWhiteSpace(catalog.CatalogId))
            {
                throw new InvalidOperationException("Schema migration catalog id cannot be empty.");
            }

            if (catalog.StartVersion > catalog.EndVersion)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} has an inverted version range.");
            }

            if (catalog.Descriptors.Count == 0)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} cannot be empty.");
            }

            if (catalogIndex > 0 && catalogs[catalogIndex - 1].EndVersion >= catalog.StartVersion)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} overlaps or precedes {catalogs[catalogIndex - 1].CatalogId}.");
            }

            ValidateCatalogDescriptors(catalog);
        }
    }

    private static void ValidateCatalogDescriptors(SchemaMigrationCatalog catalog)
    {
        var versions = new SortedSet<DateOnly>();
        for (int descriptorIndex = 0; descriptorIndex < catalog.Descriptors.Count; descriptorIndex++)
        {
            ISchemaMigrationDescriptor descriptor = catalog.Descriptors[descriptorIndex];
            DateOnly version = SchemaMigrationIdentity.ParseVersion(descriptor);
            if (version < catalog.StartVersion || version > catalog.EndVersion)
            {
                throw new InvalidOperationException(
                    $"Schema migration {descriptor.MigrationId} falls outside catalog {catalog.CatalogId} range "
                    + $"{catalog.StartVersion:yyyyMMdd}-{catalog.EndVersion:yyyyMMdd}.");
            }

            versions.Add(version);
            if (descriptorIndex > 0
                && SchemaMigrationExecutionOrder.Instance.Compare(
                    catalog.Descriptors[descriptorIndex - 1],
                    descriptor) >= 0)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} descriptors are not declared in stable execution order.");
            }
        }

        if (versions.Min != catalog.StartVersion || versions.Max != catalog.EndVersion)
        {
            throw new InvalidOperationException(
                $"Schema migration catalog {catalog.CatalogId} range must match its first and last declared versions.");
        }

        if (catalog.GapPolicy != SchemaMigrationGapPolicy.ContiguousVersions)
        {
            return;
        }

        DateOnly expected = catalog.StartVersion;
        foreach (DateOnly version in versions)
        {
            if (version != expected)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} requires contiguous versions but is missing {expected:yyyyMMdd}.");
            }

            expected = expected.AddDays(1);
        }
    }

    private static void ValidateVersionGaps(
        IReadOnlyList<SchemaMigrationCatalog> catalogs,
        IReadOnlyList<SchemaMigrationVersionGap> declaredVersionGaps)
    {
        var actualGaps = new List<SchemaMigrationVersionGap>();
        for (int index = 1; index < catalogs.Count; index++)
        {
            DateOnly gapStart = catalogs[index - 1].EndVersion.AddDays(1);
            DateOnly gapEnd = catalogs[index].StartVersion.AddDays(-1);
            if (gapStart <= gapEnd)
            {
                actualGaps.Add(new SchemaMigrationVersionGap(gapStart, gapEnd));
            }
        }

        for (int index = 0; index < declaredVersionGaps.Count; index++)
        {
            SchemaMigrationVersionGap gap = declaredVersionGaps[index];
            if (gap.StartInclusive > gap.EndInclusive)
            {
                throw new InvalidOperationException("Schema migration manifest contains an inverted declared version gap.");
            }

            if (index > 0 && declaredVersionGaps[index - 1].EndInclusive >= gap.StartInclusive)
            {
                throw new InvalidOperationException("Schema migration manifest version gaps must be ordered and non-overlapping.");
            }
        }

        if (!actualGaps.SequenceEqual(declaredVersionGaps))
        {
            string actual = string.Join(", ", actualGaps.Select(FormatGap));
            string declared = string.Join(", ", declaredVersionGaps.Select(FormatGap));
            throw new InvalidOperationException(
                $"Schema migration catalog gaps do not match the explicit manifest strategy. Actual: [{actual}]. Declared: [{declared}].");
        }
    }

    private static void ValidateDependencies(IReadOnlyList<SchemaMigrationCatalog> catalogs)
    {
        var descriptorsById = new Dictionary<string, (int CatalogIndex, ISchemaMigrationDescriptor Descriptor)>(
            StringComparer.Ordinal);
        for (int catalogIndex = 0; catalogIndex < catalogs.Count; catalogIndex++)
        {
            foreach (ISchemaMigrationDescriptor descriptor in catalogs[catalogIndex].Descriptors)
            {
                if (!descriptorsById.TryAdd(descriptor.MigrationId, (catalogIndex, descriptor)))
                {
                    throw new InvalidOperationException(
                        $"Duplicate schema migration ids found: {descriptor.MigrationId}");
                }
            }
        }

        for (int catalogIndex = 0; catalogIndex < catalogs.Count; catalogIndex++)
        {
            SchemaMigrationCatalog catalog = catalogs[catalogIndex];
            string[] duplicateDependencies =
            [
                .. catalog.Dependencies
                    .GroupBy(static dependency => dependency.MigrationId, StringComparer.Ordinal)
                    .Where(static group => group.Count() > 1)
                    .Select(static group => group.Key)
                    .Order(StringComparer.Ordinal)
            ];
            if (duplicateDependencies.Length > 0)
            {
                throw new InvalidOperationException(
                    $"Schema migration catalog {catalog.CatalogId} repeats dependencies: {string.Join(", ", duplicateDependencies)}");
            }

            foreach (SchemaMigrationCatalogDependency dependency in catalog.Dependencies)
            {
                if (!descriptorsById.TryGetValue(
                        dependency.MigrationId,
                        out (int CatalogIndex, ISchemaMigrationDescriptor Descriptor) target))
                {
                    throw new InvalidOperationException(
                        $"Schema migration catalog {catalog.CatalogId} depends on missing migration {dependency.MigrationId}.");
                }

                if (target.CatalogIndex >= catalogIndex)
                {
                    throw new InvalidOperationException(
                        $"Schema migration catalog {catalog.CatalogId} dependency {dependency.MigrationId} must belong to an earlier catalog.");
                }

                if (target.Descriptor.Phase != dependency.Phase)
                {
                    throw new InvalidOperationException(
                        $"Schema migration catalog {catalog.CatalogId} dependency {dependency.MigrationId} has mismatched phase.");
                }
            }

            if (catalogIndex == 0)
            {
                if (catalog.Dependencies.Count > 0)
                {
                    throw new InvalidOperationException("The first schema migration catalog cannot depend on an earlier catalog.");
                }

                continue;
            }

            foreach (SchemaMigrationPhase phase in catalog.Descriptors.Select(static descriptor => descriptor.Phase).Distinct())
            {
                ISchemaMigrationDescriptor latestEarlierDescriptor = catalogs
                    .Take(catalogIndex)
                    .SelectMany(static item => item.Descriptors)
                    .Where(descriptor => descriptor.Phase == phase)
                    .MaxBy(static descriptor => descriptor, SchemaMigrationExecutionOrder.Instance)
                    ?? throw new InvalidOperationException(
                        $"Schema migration catalog {catalog.CatalogId} has no earlier {phase} dependency target.");

                if (!catalog.Dependencies.Any(dependency =>
                        dependency.Phase == phase
                        && string.Equals(
                            dependency.MigrationId,
                            latestEarlierDescriptor.MigrationId,
                            StringComparison.Ordinal)))
                {
                    throw new InvalidOperationException(
                        $"Schema migration catalog {catalog.CatalogId} must depend on latest earlier {phase} migration "
                        + $"{latestEarlierDescriptor.MigrationId}.");
                }
            }
        }
    }

    private static void ValidateUniqueMigrationIds(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        string[] duplicateMigrationIds =
        [
            .. descriptors
                .GroupBy(static descriptor => descriptor.MigrationId, StringComparer.Ordinal)
                .Where(static group => group.Count() > 1)
                .Select(static group => group.Key)
                .Order(StringComparer.Ordinal)
        ];
        if (duplicateMigrationIds.Length > 0)
        {
            throw new InvalidOperationException(
                $"Duplicate schema migration ids found: {string.Join(", ", duplicateMigrationIds)}");
        }
    }

    private static string FormatGap(SchemaMigrationVersionGap gap)
        => $"{gap.StartInclusive:yyyyMMdd}-{gap.EndInclusive:yyyyMMdd}";
}
