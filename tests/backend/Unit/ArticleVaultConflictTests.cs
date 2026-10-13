using System.Collections.Immutable;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultConflictTests
{
    [Fact]
    public void CompiledConflictOwners_HaveNoFilesystemGitNetworkProcessOrWriterReferences()
    {
        Type[] owners = typeof(ArticleVaultConflictVerifier).Assembly.GetTypes()
            .Where(static type => type.Namespace == "FsusBlog.Shared.Contracts.ArticleVault"
                && (type.Name.StartsWith("ArticleVaultConflict", StringComparison.Ordinal)
                    || type.Name.StartsWith("VaultConflict", StringComparison.Ordinal)))
            .ToArray();
        Assert.Contains(typeof(ArticleVaultConflictRegistry), owners);
        Assert.Contains(typeof(ArticleVaultConflictVerifier), owners);
        Assert.Contains(typeof(ArticleVaultConflictCodec), owners);
        Assert.Contains(typeof(ArticleVaultConflictEvidence), owners);
        RuntimeMetadataInspection.RuntimeMemberSite[] sites = owners
            .SelectMany(static owner => RuntimeMetadataInspection.ReadMemberSites(owner))
            .ToArray();
        Assert.NotEmpty(sites);
        Assert.DoesNotContain(sites, static site => IsForbiddenConflictReference(site.Member));
    }

    [Theory]
    [InlineData(typeof(ConflictFileInfoConstructorFixture), "System.IO.FileInfo")]
    [InlineData(typeof(ConflictDirectoryInfoConstructorFixture), "System.IO.DirectoryInfo")]
    [InlineData(typeof(ConflictWatcherConstructorFixture), "System.IO.FileSystemWatcher")]
    [InlineData(typeof(ConflictNetworkConstructorFixture), "System.Net.Http.HttpClient")]
    [InlineData(typeof(ConflictProcessConstructorFixture), "System.Diagnostics.ProcessStartInfo")]
    [InlineData(typeof(ConflictStaticFilesystemFixture), "System.IO.File")]
    [InlineData(typeof(ConflictWriterReferenceFixture), "FsusBlog.Server.Services.ArticleVault.IArticleVaultCanonicalGroupWriter")]
    public void CompiledBoundary_RejectsForbiddenMethodsAndConstructorsWithoutExecutingThem(
        Type fixtureType,
        string declaringTypeName)
    {
        IReadOnlyList<RuntimeMetadataInspection.RuntimeMemberSite> sites = RuntimeMetadataInspection.ReadMemberSites(fixtureType);
        Assert.Contains(sites, site => site.Member.DeclaringType?.FullName == declaringTypeName);
        Assert.Contains(sites, static site => IsForbiddenConflictReference(site.Member));
    }

    [Fact]
    public void CompiledBoundary_AllowsPureValidationExceptionsAndCanonicalCodecReferences()
    {
        IReadOnlyList<RuntimeMetadataInspection.RuntimeMemberSite> sites = RuntimeMetadataInspection.ReadMemberSites(
            typeof(ConflictPureValidationFixture));
        Assert.Contains(sites, static site => site.Member.DeclaringType == typeof(InvalidDataException));
        Assert.Contains(sites, static site => site.Member.DeclaringType == typeof(ArticleVaultManifestCodec));
        Assert.DoesNotContain(sites, static site => IsForbiddenConflictReference(site.Member));
    }

    private static bool IsForbiddenConflictReference(System.Reflection.MemberInfo member)
    {
        Type? declaring = member as Type ?? member.DeclaringType;
        if (declaring is null)
        {
            return false;
        }

        string typeNamespace = declaring.Namespace ?? string.Empty;
        string typeName = declaring.FullName ?? declaring.Name;
        if (typeNamespace == "System.IO" || typeNamespace.StartsWith("System.IO.", StringComparison.Ordinal))
        {
            // A validation exception does not read files, create watchers or acquire filesystem authority.
            return !typeof(Exception).IsAssignableFrom(declaring);
        }

        return typeNamespace == "LibGit2Sharp"
            || typeNamespace.StartsWith("LibGit2Sharp.", StringComparison.Ordinal)
            || typeNamespace == "System.Net.Http"
            || typeNamespace.StartsWith("System.Net.Http.", StringComparison.Ordinal)
            || typeNamespace == "System.Net.Sockets"
            || typeNamespace.StartsWith("System.Net.Sockets.", StringComparison.Ordinal)
            || typeNamespace == "System.Net.WebSockets"
            || typeNamespace.StartsWith("System.Net.WebSockets.", StringComparison.Ordinal)
            || typeName is "System.Diagnostics.Process" or "System.Diagnostics.ProcessStartInfo"
            || typeNamespace == "Npgsql"
            || typeNamespace.StartsWith("Npgsql.", StringComparison.Ordinal)
            || typeNamespace == "SqlSugar"
            || typeNamespace.StartsWith("SqlSugar.", StringComparison.Ordinal)
            || typeNamespace == "FsusBlog.Server.Services"
            || typeNamespace.StartsWith("FsusBlog.Server.Services.", StringComparison.Ordinal);
    }

    // These fixtures are inspected as IL only. No constructor or method below is invoked.
    private sealed class ConflictFileInfoConstructorFixture
    {
        private ConflictFileInfoConstructorFixture() => GC.KeepAlive(new System.IO.FileInfo("fixture"));
    }

    private sealed class ConflictDirectoryInfoConstructorFixture
    {
        private ConflictDirectoryInfoConstructorFixture() => GC.KeepAlive(new System.IO.DirectoryInfo("fixture"));
    }

    private sealed class ConflictWatcherConstructorFixture
    {
        private ConflictWatcherConstructorFixture()
        {
            using var watcher = new System.IO.FileSystemWatcher();
            GC.KeepAlive(watcher);
        }
    }

    private sealed class ConflictNetworkConstructorFixture
    {
        private ConflictNetworkConstructorFixture()
        {
            using var client = new System.Net.Http.HttpClient();
            GC.KeepAlive(client);
        }
    }

    private sealed class ConflictProcessConstructorFixture
    {
        private ConflictProcessConstructorFixture() => GC.KeepAlive(new System.Diagnostics.ProcessStartInfo("git"));
    }

    private static class ConflictStaticFilesystemFixture
    {
        static ConflictStaticFilesystemFixture() => GC.KeepAlive(System.IO.File.Exists("fixture"));
    }

    private static class ConflictWriterReferenceFixture
    {
        private static Task<FsusBlog.Server.Services.ArticleVault.ArticleVaultGroupResultReceipt> Run(
            FsusBlog.Server.Services.ArticleVault.IArticleVaultCanonicalGroupWriter writer)
            => writer.ExecuteGroupAsync(null!, null!, []);
    }

    private static class ConflictPureValidationFixture
    {
        private static void Run()
        {
            GC.KeepAlive(new InvalidDataException("fixture-invalid-data"));
            GC.KeepAlive(ArticleVaultManifestCodec.ComputeSha256([0x41]));
        }
    }

    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Theory]
    [InlineData(VaultConflictType.SourceDisjoint)]
    [InlineData(VaultConflictType.SourceOverlap)]
    [InlineData(VaultConflictType.MetadataDisjoint)]
    [InlineData(VaultConflictType.MetadataOverlap)]
    [InlineData(VaultConflictType.RenameVsEdit)]
    [InlineData(VaultConflictType.DeleteVsEdit)]
    [InlineData(VaultConflictType.CreateCreate)]
    [InlineData(VaultConflictType.LifecycleConflict)]
    [InlineData(VaultConflictType.PermissionConflict)]
    [InlineData(VaultConflictType.SchemaConflict)]
    [InlineData(VaultConflictType.DependencyConflict)]
    [InlineData(VaultConflictType.GitMarkerPresent)]
    public void Registry_PreservesAuthority(VaultConflictType type)
    {
        Assert.Equal(12, ArticleVaultConflictRegistry.Entries.Length);
        VaultConflictRegistryEntry entry = Assert.IsType<VaultConflictRegistryEntry>(ArticleVaultConflictRegistry.Find(type));
        Assert.Equal(type, entry.Type);
        Assert.True(ArticleVaultConflictRegistry.Validate(ArticleVaultConflictRegistry.Entries).IsValid);
        Assert.Equal($"ArticleVaultConflictTests.Registry_PreservesAuthority({type})", entry.ProofTestIdentity);
        Assert.Contains(VaultConflictAction.CancelOperation, entry.AllowedActions);
        if (type is VaultConflictType.LifecycleConflict or VaultConflictType.PermissionConflict
            or VaultConflictType.SchemaConflict or VaultConflictType.DependencyConflict or VaultConflictType.GitMarkerPresent)
        {
            Assert.Equal(VaultConflictDisposition.Rejected, entry.Disposition);
            Assert.Collection(entry.AllowedActions,
                action => Assert.Equal(VaultConflictAction.RefreshEvidence, action),
                action => Assert.Equal(VaultConflictAction.CancelOperation, action));
        }
    }

    [Fact]
    public void Registry_RejectsMissingDuplicateWildcardAndUnownedActions()
    {
        ImmutableArray<VaultConflictRegistryEntry> entries = ArticleVaultConflictRegistry.Entries;
        Assert.False(ArticleVaultConflictRegistry.Validate(entries.RemoveAt(0)).IsValid);
        Assert.False(ArticleVaultConflictRegistry.Validate(entries.SetItem(1, entries[0])).IsValid);
        Assert.False(ArticleVaultConflictRegistry.Validate(entries.SetItem(0, entries[0] with
        {
            Owner = "*"
        })).IsValid);
        Assert.False(ArticleVaultConflictRegistry.Validate(entries.SetItem(0, entries[0] with
        {
            AllowedActions = [(VaultConflictAction)999]
        })).IsValid);
        Assert.Null(ArticleVaultConflictRegistry.Find((VaultConflictType)999));
    }

    [Fact]
    public void SourceDisjoint_RequiresIndependentCurrentFactsAndDoesNotUnblockOriginalPlan()
    {
        Fixture fixture = CreateFixture();
        Assert.True(Verify(fixture).IsValid);
        Assert.Equal(VaultSyncPlanStatus.Blocked, fixture.Plan.Status);
        Assert.Equal("both_modified", Assert.Single(fixture.Plan.Conflicts).ReasonCode);
        Assert.Empty(fixture.Plan.OperationOrder);
        Assert.Equal(VaultConflictDisposition.Automatic, Assert.Single(fixture.Evidence.Items).Disposition);
        Assert.Equal("article_vault_conflict_independent_source_reader_missing",
            ArticleVaultConflictVerifier.ValidateAutomaticEligibility(fixture.Evidence).ReasonCode);
        Assert.Equal("article_vault_conflict_current_facts_missing_or_duplicate", Verify(fixture, facts: []).ReasonCode);
        Assert.Equal("article_vault_conflict_current_facts_drift", Verify(fixture, facts:
        [
            fixture.Facts[0] with { Source = fixture.Facts[0].Source! with { ParserVersion = 2 } }
        ]).ReasonCode);
    }

    [Theory]
    [InlineData(5, 15, "node-server")]
    [InlineData(20, 30, "node-local")]
    [InlineData(10, 10, "node-server")]
    public void SourceOverlap_CannotBeClassifiedAutomatic(long start, long end, string node)
    {
        Fixture fixture = CreateFixture();
        VaultConflictObservation changed = fixture.Facts[0] with
        {
            Source = fixture.Facts[0].Source! with
            {
                ServerChanges = [new(start, end, node)]
            }
        };
        ArticleVaultConflictEvidence wrong = WithObservation(fixture.Evidence, changed);
        Assert.Equal("article_vault_conflict_source_disposition_mismatch", ArticleVaultConflictVerifier.ValidateStructure(wrong).ReasonCode);
        VaultConflictObservation overlap = changed with
        {
            Type = VaultConflictType.SourceOverlap
        };
        ArticleVaultConflictEvidence manual = WithObservation(fixture.Evidence, overlap);
        Assert.True(ArticleVaultConflictVerifier.ValidateStructure(manual).IsValid);
        Assert.Equal(VaultConflictDisposition.Manual, Assert.Single(manual.Items).Disposition);
    }

    [Fact]
    public void SourceFacts_RejectMissingRangesBadBoundsAndUnknownParser()
    {
        Fixture fixture = CreateFixture();
        VaultConflictSourceFacts original = fixture.Facts[0].Source!;
        VaultConflictSourceFacts[] invalid =
        [
            original with { LocalChanges = [] },
            original with { ServerChanges = [new(-1, 10, "node")] },
            original with { ServerChanges = [new(40, 101, "node")] },
            original with { ServerChanges = [new(25, 24, "node")] },
            original with { ServerChanges = [new(20, 30, "*")] },
            original with { ParserVersion = 0 },
            original with { ParserSha256 = "unsealed" }
        ];
        foreach (VaultConflictSourceFacts facts in invalid)
        {
            Assert.Equal("article_vault_conflict_source_facts_invalid", ArticleVaultConflictVerifier.ValidateStructure(
                WithObservation(fixture.Evidence, fixture.Facts[0] with
                {
                    Source = facts
                })).ReasonCode);
        }
    }

    [Fact]
    public void ClosedCodec_RoundTripsAndRejectsWinnerFlagsAndUnknownNumericTypes()
    {
        Fixture fixture = CreateFixture();
        byte[] serialized = ArticleVaultConflictCodec.Serialize(fixture.Evidence);
        Assert.Equal(serialized, ArticleVaultConflictCodec.Serialize(ArticleVaultConflictCodec.Deserialize(serialized)));
        string json = Encoding.UTF8.GetString(serialized);
        string[] forbidden = ["winnerMtime", "winnerSize", "longerContent", "aiScore", "gitRename", "acceptAllLocal", "acceptAllServer"];
        foreach (string field in forbidden)
        {
            Assert.Throws<InvalidDataException>(() => ArticleVaultConflictCodec.Deserialize(
                Encoding.UTF8.GetBytes(json[..^1] + $",\"{field}\":true}}")));
        }
        Assert.Throws<InvalidDataException>(() => ArticleVaultConflictCodec.Deserialize(
            Encoding.UTF8.GetBytes(json.Replace("\"source-disjoint\"", "999", StringComparison.Ordinal))));
    }

    [Fact]
    public void Evidence_RejectsUnknownDuplicateTypesAuthorityBypassAndRegistryDrift()
    {
        Fixture fixture = CreateFixture();
        VaultConflictItem item = fixture.Evidence.Items[0];
        ArticleVaultConflictEvidence[] invalid =
        [
            fixture.Evidence with { Items = [item, item] },
            fixture.Evidence with { Items = [item with { Type = (VaultConflictType)999 }] },
            fixture.Evidence with { Items = [item with { Disposition = VaultConflictDisposition.Manual }] },
            fixture.Evidence with { Items = [item with { AllowedActions = [VaultConflictAction.ProposeSourceReplacement] }] },
            fixture.Evidence with { RegistrySha256 = DigestA },
            fixture.Evidence with { SchemaVersion = 2 },
            fixture.Evidence with { Items = [] }
        ];
        foreach (ArticleVaultConflictEvidence evidence in invalid)
        {
            if (evidence.Items.Any(static value => !Enum.IsDefined(value.Type)))
            {
                Assert.Equal("article_vault_conflict_type_unknown_or_duplicate",
                    ArticleVaultConflictVerifier.ValidateStructure(evidence).ReasonCode);
                Assert.Throws<System.Text.Json.JsonException>(() => Seal(evidence));
            }
            else
            {
                Assert.False(ArticleVaultConflictVerifier.ValidateStructure(Seal(evidence)).IsValid);
            }
        }
        Assert.Equal("article_vault_conflict_digest_mismatch", ArticleVaultConflictVerifier.ValidateStructure(
            fixture.Evidence with
            {
                ContentSha256 = DigestA
            }).ReasonCode);
    }

    [Theory]
    [InlineData(VaultConflictType.LifecycleConflict)]
    [InlineData(VaultConflictType.PermissionConflict)]
    public void ServerAuthorityConflict_RejectsAutomaticOrGenericLocalAction(VaultConflictType type)
    {
        Fixture fixture = CreateFixture(authority: type);
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(type)!;
        VaultArticleCoordinates coordinates = fixture.Evidence.Binding.Coordinates;
        VaultConflictObservation observed = new(type, null, null, new(entry.RequiredFact,
            coordinates.Base.ContentSha256, coordinates.Local.ContentSha256, coordinates.Server.ContentSha256, null, null));
        ArticleVaultConflictEvidence evidence = WithObservation(fixture.Evidence, observed);
        Assert.True(Verify(fixture with
        {
            Evidence = evidence,
            Facts = [observed]
        }).IsValid);
        VaultConflictItem item = evidence.Items[0];
        Assert.False(ArticleVaultConflictVerifier.ValidateStructure(Seal(evidence with
        {
            Items = [item with { Disposition = VaultConflictDisposition.Automatic }]
        })).IsValid);
        Assert.False(ArticleVaultConflictVerifier.ValidateStructure(Seal(evidence with
        {
            Items = [item with { AllowedActions = [VaultConflictAction.ProposeMetadataReplacement] }]
        })).IsValid);
    }

    [Fact]
    public void Binding_RejectsCrossSiteVaultDeviceArticleGroupOperationAndPlan()
    {
        Fixture fixture = CreateFixture();
        VaultConflictBinding binding = fixture.Evidence.Binding;
        VaultConflictBinding[] altered =
        [
            binding with { SiteIdentity = "site-other" },
            binding with { VaultIdentity = "vault-other" },
            binding with { DeviceIdentity = "device-other" },
            binding with { PortableArticleIdentity = "article-other" },
            binding with { ServerArticleIdentity = "server-other" },
            binding with { GroupIdentity = "group-other" },
            binding with { OperationIdentity = "operation-other" },
            binding with { PlanCandidateIdentity = "plan-other" },
            binding with { PlanSha256 = DigestA },
            binding with { ArticleManifestSha256 = DigestA },
            binding with { ServerObservationSha256 = DigestA }
        ];
        foreach (VaultConflictBinding changed in altered)
        {
            Assert.False(Verify(fixture with
            {
                Evidence = Seal(fixture.Evidence with
                {
                    Binding = changed
                })
            }).IsValid);
        }
    }

    [Fact]
    public void Binding_RejectsResealedCoordinateChangesAndActualCurrentDrift()
    {
        Fixture fixture = CreateFixture();
        VaultArticleCoordinate server = fixture.Evidence.Binding.Coordinates.Server;
        VaultArticleCoordinate[] drifts =
        [
            Seal(server with { ServerRevision = 6 }),
            Seal(server with { MetadataManifestSha256 = DigestB }),
            Seal(server with { DependencySha256 = DigestB }),
            Seal(server with { PermissionSha256 = DigestB }),
            Seal(server with { Source = server.Source! with { Sha256 = DigestA } })
        ];
        foreach (VaultArticleCoordinate changed in drifts)
        {
            Assert.NotEqual(server.ContentSha256, changed.ContentSha256);
            VaultConflictBinding binding = fixture.Evidence.Binding with
            {
                Coordinates = fixture.Evidence.Binding.Coordinates with
                {
                    Server = changed
                }
            };
            Assert.False(Verify(fixture with
            {
                Evidence = Seal(fixture.Evidence with
                {
                    Binding = binding
                })
            }).IsValid);
        }
        ArticleVaultServerObservation current = Seal(fixture.Observation with
        {
            ServerCoordinate = Seal(server with
            {
                ServerRevision = 6
            })
        });
        Assert.Equal("article_vault_plan_coordinate_drift", Verify(fixture, observations: [current]).ReasonCode);
        Assert.Equal("article_vault_plan_expired", Verify(fixture, nowUnixMs: fixture.Plan.ExpiresAtUnixMs + 1).ReasonCode);
    }

    [Fact]
    public void MissingBase_IsRejectedIncludingCreateCreateInsteadOfGenericManual()
    {
        Fixture fixture = CreateFixture();
        VaultArticleCoordinate absent = Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate, 1, false, false, null, null, null, null, null, null, string.Empty));
        VaultConflictObservation creation = new(VaultConflictType.CreateCreate, null, null,
            new(VaultConflictFactKind.Creation, absent.ContentSha256,
                fixture.Evidence.Binding.Coordinates.Local.ContentSha256,
                fixture.Evidence.Binding.Coordinates.Server.ContentSha256, null, null));
        ArticleVaultConflictEvidence evidence = WithObservation(fixture.Evidence, creation);
        evidence = Seal(evidence with
        {
            Binding = evidence.Binding with
            {
                Coordinates = evidence.Binding.Coordinates with
                {
                    Base = absent
                }
            }
        });
        Assert.Equal("article_vault_conflict_base_missing", ArticleVaultConflictVerifier.ValidateStructure(evidence).ReasonCode);
    }

    [Fact]
    public void Metadata_StableFieldsDisjointEquivalentAndOverlappingAreDistinguished()
    {
        Fixture fixture = CreateFixture(metadata: true);
        VaultConflictObservation disjoint = new(VaultConflictType.MetadataDisjoint, null,
            new(DigestA,
            [
                new(VaultConflictMetadataField.Title, null, DigestA, DigestB, DigestA),
                new(VaultConflictMetadataField.Summary, null, DigestA, DigestA, DigestC)
            ]), null);
        ArticleVaultConflictEvidence evidence = WithObservation(fixture.Evidence, disjoint);
        Assert.True(Verify(fixture with
        {
            Evidence = evidence,
            Facts = [disjoint]
        }).IsValid);
        Assert.Equal("article_vault_conflict_independent_metadata_reader_missing",
            ArticleVaultConflictVerifier.ValidateAutomaticEligibility(evidence).ReasonCode);
        VaultConflictObservation overlap = disjoint with
        {
            Metadata = disjoint.Metadata! with
            {
                Changes = [new(VaultConflictMetadataField.Title, null, DigestA, DigestB, DigestC)]
            }
        };
        Assert.Equal("article_vault_conflict_metadata_disposition_mismatch", ArticleVaultConflictVerifier.ValidateStructure(
            WithObservation(evidence, overlap)).ReasonCode);
        VaultConflictObservation manual = overlap with
        {
            Type = VaultConflictType.MetadataOverlap
        };
        Assert.True(ArticleVaultConflictVerifier.ValidateStructure(WithObservation(evidence, manual)).IsValid);
        VaultConflictObservation equivalent = overlap with
        {
            Metadata = overlap.Metadata! with
            {
                Changes = [new(VaultConflictMetadataField.Title, null, DigestA, DigestB, DigestB)]
            }
        };
        Assert.True(ArticleVaultConflictVerifier.ValidateStructure(WithObservation(evidence, equivalent)).IsValid);
    }

    [Fact]
    public void Metadata_RejectsUnknownFieldsDuplicateIdsLabelsAndStaleFieldSchema()
    {
        Fixture fixture = CreateFixture(metadata: true);
        VaultConflictMetadataChange title = new(VaultConflictMetadataField.Title, null, DigestA, DigestB, DigestC);
        VaultConflictObservation observed = new(VaultConflictType.MetadataOverlap, null, new(DigestA, [title]), null);
        ImmutableArray<VaultConflictMetadataChange>[] invalid =
        [
            [title with { Field = (VaultConflictMetadataField)999 }],
            [title, title],
            [title with { EntityIdentity = "localized title" }],
            [title with { Field = VaultConflictMetadataField.Taxonomy, EntityIdentity = "same label" }]
        ];
        foreach (ImmutableArray<VaultConflictMetadataChange> changes in invalid)
        {
            VaultConflictObservation changed = observed with
            {
                Metadata = observed.Metadata! with
                {
                    Changes = changes
                }
            };
            if (changes.Any(static value => !Enum.IsDefined(value.Field)))
            {
                VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(changed.Type)!;
                ArticleVaultConflictEvidence invalidEvidence = fixture.Evidence with
                {
                    Items = [new(changed.Type, entry.Disposition, entry.AllowedActions, changed)]
                };
                Assert.Equal("article_vault_conflict_metadata_field_invalid",
                    ArticleVaultConflictVerifier.ValidateStructure(invalidEvidence).ReasonCode);
                Assert.Throws<System.Text.Json.JsonException>(() => WithObservation(fixture.Evidence, changed));
            }
            else
            {
                Assert.False(ArticleVaultConflictVerifier.ValidateStructure(
                    WithObservation(fixture.Evidence, changed)).IsValid);
            }
        }
        ArticleVaultConflictEvidence evidence = WithObservation(fixture.Evidence, observed);
        Assert.Equal("article_vault_conflict_current_facts_drift", Verify(fixture with
        {
            Evidence = evidence,
            Facts = [observed]
        }, facts:
        [
            observed with { Metadata = observed.Metadata! with { FieldRegistrySha256 = DigestB } }
        ]).ReasonCode);
    }

    [Theory]
    [InlineData(VaultConflictType.LifecycleConflict)]
    [InlineData(VaultConflictType.PermissionConflict)]
    [InlineData(VaultConflictType.DependencyConflict)]
    [InlineData(VaultConflictType.DeleteVsEdit)]
    [InlineData(VaultConflictType.CreateCreate)]
    [InlineData(VaultConflictType.SchemaConflict)]
    public void AuthorityFact_CannotBeInventedFromKindAndCoordinateDigests(VaultConflictType type)
    {
        Fixture fixture = CreateFixture();
        VaultArticleCoordinates coordinates = fixture.Evidence.Binding.Coordinates;
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(type)!;
        VaultConflictObservation observed = new(type, null, null, new(entry.RequiredFact,
            coordinates.Base.ContentSha256, coordinates.Local.ContentSha256, coordinates.Server.ContentSha256, null, null));
        Assert.Equal("article_vault_conflict_authority_fact_not_observed", ArticleVaultConflictVerifier.ValidateStructure(
            WithObservation(fixture.Evidence, observed)).ReasonCode);
    }

    [Fact]
    public void RenameAndGit_TypedFactsCannotSubstituteForMissingActualReaders()
    {
        Fixture fixture = CreateFixture();
        VaultArticleCoordinates coordinates = fixture.Evidence.Binding.Coordinates;
        static VaultPathProjection Projection(string path)
            => new(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path));
        VaultConflictObservation rename = new(VaultConflictType.RenameVsEdit, null, null,
            new(VaultConflictFactKind.IdentityProjection, coordinates.Base.ContentSha256,
                coordinates.Local.ContentSha256, coordinates.Server.ContentSha256,
                new(Projection("articles/original.md"), Projection("articles/renamed.md"), Projection("articles/original.md")), null));
        VaultConflictObservation git = new(VaultConflictType.GitMarkerPresent, null, null,
            new(VaultConflictFactKind.GitMarkers, coordinates.Base.ContentSha256,
                coordinates.Local.ContentSha256, coordinates.Server.ContentSha256, null,
                new("worktree-primary", DigestA, DigestB, [new(0, 7, "marker-node")])));
        Assert.Equal("article_vault_conflict_identity_observer_missing", ArticleVaultConflictVerifier.ValidateStructure(
            WithObservation(fixture.Evidence, rename)).ReasonCode);
        Assert.Equal("article_vault_conflict_git_observer_missing", ArticleVaultConflictVerifier.ValidateStructure(
            WithObservation(fixture.Evidence, git)).ReasonCode);
        Assert.Equal(fixture.Article.PortableArticleIdentity, fixture.Evidence.Binding.PortableArticleIdentity);
    }

    [Fact]
    public void AutomaticEligibility_RefusesAuthorityDriftAndArbitraryReaderDigests()
    {
        Fixture fixture = CreateFixture();
        VaultArticleCoordinates coordinates = fixture.Evidence.Binding.Coordinates;
        VaultArticleCoordinate server = Seal(coordinates.Server with
        {
            Lifecycle = "published"
        });
        ArticleVaultConflictEvidence drifted = Seal(fixture.Evidence with
        {
            Binding = fixture.Evidence.Binding with
            {
                Coordinates = coordinates with
                {
                    Server = server
                }
            }
        });
        Assert.Equal("article_vault_conflict_automatic_authority_drift", ArticleVaultConflictVerifier.ValidateStructure(drifted).ReasonCode);
        VaultConflictObservation arbitrary = fixture.Facts[0] with
        {
            Source = fixture.Facts[0].Source! with
            {
                ParserSha256 = DigestC,
                AlgorithmSha256 = DigestC
            }
        };
        Assert.Equal("article_vault_conflict_independent_source_reader_missing",
            ArticleVaultConflictVerifier.ValidateAutomaticEligibility(WithObservation(fixture.Evidence, arbitrary)).ReasonCode);
    }

    private static ArticleVaultValidationResult Verify(
        Fixture fixture,
        IReadOnlyList<VaultConflictObservation>? facts = null,
        IReadOnlyList<ArticleVaultServerObservation>? observations = null,
        long? nowUnixMs = null)
        => ArticleVaultConflictVerifier.VerifyCurrentBinding(fixture.Evidence, fixture.Plan, fixture.Root,
            [fixture.Article], observations ?? [fixture.Observation],
            new(nowUnixMs ?? 1_800_000_000_000, VaultSyncDirection.Sync, false), facts ?? fixture.Facts);

    private static ArticleVaultConflictEvidence WithObservation(
        ArticleVaultConflictEvidence evidence,
        VaultConflictObservation observation)
    {
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(observation.Type)!;
        return Seal(evidence with
        {
            Items = [new(observation.Type, entry.Disposition, entry.AllowedActions, observation)]
        });
    }

    private static Fixture CreateFixture(bool metadata = false, VaultConflictType? authority = null)
    {
        VaultArticleCoordinate baseline = Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate, 1, true, false, 4,
            new(DigestA, 100, false, VaultNewlineStyle.Lf, 0, true),
            DigestA, DigestA, "draft", DigestA, string.Empty));
        VaultArticleCoordinate local = Seal(baseline with
        {
            Source = metadata ? baseline.Source : baseline.Source! with
            {
                Sha256 = DigestB
            },
            MetadataManifestSha256 = metadata ? DigestB : DigestA
        });
        VaultArticleCoordinate server = Seal(baseline with
        {
            ServerRevision = 5,
            Source = metadata ? baseline.Source : baseline.Source! with
            {
                Sha256 = DigestC
            },
            MetadataManifestSha256 = metadata ? DigestC : DigestA,
            Lifecycle = authority == VaultConflictType.LifecycleConflict ? "published" : baseline.Lifecycle,
            PermissionSha256 = authority == VaultConflictType.PermissionConflict ? DigestC : baseline.PermissionSha256
        });
        const string Path = "articles/article-primary.md";
        ArticleVaultArticleManifest article = new(ArticleVaultSchemas.ArticleManifest, 1,
            "site-primary", "vault-primary", "device-primary", "article-primary", "server-primary",
            new(Path, ArticleVaultManifestCodec.ComputeProjectionSha256(Path)),
            new(baseline, local, baseline), new(0, null, null, null, null, null, null), VaultArticleState.LocalModified, string.Empty);
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        ArticleVaultServerObservation observation = Seal(new ArticleVaultServerObservation(
            ArticleVaultPlanSchemas.ServerObservation, 1, article.SiteIdentity, article.VaultIdentity,
            article.DeviceIdentity, article.PortableArticleIdentity, article.ServerArticleIdentity, server, string.Empty));
        ArticleVaultRootManifest root = new(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            [new(article.PortableArticleIdentity, ".fsus/articles/article-primary.json", article.ContentSha256, Path)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-primary", [article.PortableArticleIdentity], [])], VaultSyncDirection.Sync,
            1_800_000_000_000, 1_800_000_060_000, false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        VaultSyncPlanItem item = plan.Groups[0].Items[0];
        VaultConflictObservation facts = new(VaultConflictType.SourceDisjoint,
            new("parser-primary", 1, DigestA, DigestB, [new(0, 10, "node-local")], [new(20, 30, "node-server")]), null, null);
        VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(facts.Type)!;
        ArticleVaultConflictEvidence evidence = Seal(new ArticleVaultConflictEvidence(ArticleVaultConflictSchemas.Evidence, 1,
            ArticleVaultConflictRegistry.ContentSha256,
            new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, item.PortableArticleIdentity,
                item.ServerArticleIdentity, plan.PlanCandidateIdentity, plan.ContentSha256, item.GroupIdentity,
                item.OperationIdentity, article.ContentSha256, observation.ContentSha256, new(item.Base, item.Local, item.Server)),
            [new(facts.Type, entry.Disposition, entry.AllowedActions, facts)], string.Empty));
        return new(root, article, observation, plan, evidence, [facts]);
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
        => coordinate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
        };

    private static ArticleVaultServerObservation Seal(ArticleVaultServerObservation observation)
        => observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };

    private static ArticleVaultConflictEvidence Seal(ArticleVaultConflictEvidence evidence)
        => evidence with
        {
            ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
        };

    private sealed record Fixture(
        ArticleVaultRootManifest Root,
        ArticleVaultArticleManifest Article,
        ArticleVaultServerObservation Observation,
        ArticleVaultSyncPlan Plan,
        ArticleVaultConflictEvidence Evidence,
        IReadOnlyList<VaultConflictObservation> Facts);
}
