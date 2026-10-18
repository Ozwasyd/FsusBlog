using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal sealed record OfflineMigrationSourceShape(
    CurrentSchemaProviderKind Provider,
    string ExtractorId,
    string ExtractorVersion,
    ImmutableArray<OfflineMigrationFact> Schema,
    ImmutableArray<OfflineMigrationFact> History,
    ImmutableArray<OfflineMigrationFact> BusinessShape);

internal sealed record OfflineMigrationFingerprintDefinition(
    string Id,
    string Version,
    string Owner,
    ImmutableArray<string> ProofTests,
    string EntryStepId,
    ImmutableArray<OfflineMigrationSourceShape> Providers);

internal sealed record OfflineMigrationDag(
    string Id,
    string Version,
    ImmutableArray<OfflineMigrationStep> Steps);

/// <summary>
/// A verified payload carrier, not an execution grant. Apply must re-observe its locked
/// database and exact journal progress before any write; deserialized plans never construct this carrier.
/// </summary>
public sealed class VerifiedOfflineMigrationPlan
{
    internal VerifiedOfflineMigrationPlan(OfflineMigrationPlan plan)
    {
        Plan = plan;
    }

    /// <summary>The immutable, canonically sealed payload checked by the plan verifier.</summary>
    public OfflineMigrationPlan Plan
    {
        get;
    }
}

internal sealed class OfflineMigrationSourceRegistry
{
    private readonly ImmutableArray<OfflineMigrationFingerprintDefinition> _entries;

    internal OfflineMigrationSourceRegistry(string version, ImmutableArray<OfflineMigrationFingerprintDefinition> entries)
    {
        OfflineMigrationPlanValidation.RequireText(version, "source_registry_version_missing");
        if (entries.IsDefaultOrEmpty)
        {
            throw new InvalidOperationException("source_registry_empty");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (OfflineMigrationFingerprintDefinition entry in entries)
        {
            OfflineMigrationPlanValidation.RequireText(entry.Id, "source_fingerprint_id_missing");
            OfflineMigrationPlanValidation.RequireText(entry.Version, "source_fingerprint_version_missing");
            OfflineMigrationPlanValidation.RequireText(entry.Owner, "source_fingerprint_owner_missing");
            OfflineMigrationPlanValidation.RequireText(entry.EntryStepId, "source_fingerprint_entry_step_missing");
            if (!ids.Add(entry.Id) || entry.ProofTests.IsDefaultOrEmpty
                || entry.ProofTests.Distinct(StringComparer.Ordinal).Count() != entry.ProofTests.Length)
            {
                throw new InvalidOperationException("source_fingerprint_definition_invalid");
            }

            foreach (string proof in entry.ProofTests)
            {
                OfflineMigrationPlanValidation.RequireText(proof, "source_fingerprint_proof_invalid");
            }

            OfflineMigrationPlanValidation.RequireProviders(entry.Providers.Select(shape => shape.Provider));
            foreach (OfflineMigrationSourceShape shape in entry.Providers)
            {
                OfflineMigrationPlanValidation.ValidateShape(shape);
            }
        }

        _entries = entries.OrderBy(entry => entry.Id, StringComparer.Ordinal).Select(entry => entry with
        {
            ProofTests = entry.ProofTests.OrderBy(value => value, StringComparer.Ordinal).ToImmutableArray(),
            Providers = entry.Providers.OrderBy(shape => shape.Provider).Select(shape => shape with
            {
                Schema = OfflineMigrationPlanValidation.NormalizeFacts(shape.Schema),
                History = OfflineMigrationPlanValidation.NormalizeFacts(shape.History),
                BusinessShape = OfflineMigrationPlanValidation.NormalizeFacts(shape.BusinessShape)
            }).ToImmutableArray()
        }).ToImmutableArray();
        Digest = OfflineMigrationPlanValidation.Digest(new
        {
            Version = version,
            Entries = _entries
        });
    }

    internal string Digest
    {
        get;
    }

    internal OfflineMigrationFingerprintDefinition Match(OfflineMigrationSourceObservation observation)
    {
        OfflineMigrationPlanValidation.ValidateObservation(observation);
        var matches = new List<OfflineMigrationFingerprintDefinition>();
        OfflineMigrationSourceShape actual = OfflineMigrationPlanValidation.Shape(observation);
        foreach (OfflineMigrationFingerprintDefinition entry in _entries)
        {
            OfflineMigrationSourceShape expected = entry.Providers.Single(shape => shape.Provider == actual.Provider);
            string[] entryDifferences = OfflineMigrationPlanValidation.Differences(expected, actual);
            if (entryDifferences.Length == 0)
            {
                matches.Add(entry);
            }
        }

        if (matches.Count != 1)
        {
            throw matches.Count == 0
                ? OfflineMigrationSourceFingerprintException.Unknown(_entries.Select(entry =>
                    (entry.Id, entry.Providers.Single(shape => shape.Provider == actual.Provider))), actual)
                : OfflineMigrationSourceFingerprintException.Ambiguous(matches.Select(entry => entry.Id));
        }

        return matches[0];
    }
}

internal static class OfflineMigrationPlanBuilder
{
    internal const string Format = "fsusblog.offline-migration-plan.v1";

    internal static OfflineMigrationPlan Create(
        OfflineMigrationSourceObservation source,
        OfflineMigrationBackupObservation backup,
        CurrentSchemaTargetIdentity target,
        CurrentSchemaVerifierIdentity tool,
        OfflineMigrationSourceRegistry registry,
        OfflineMigrationDag dag,
        DateTimeOffset admissionTime,
        TimeSpan maximumBackupAge)
    {
        OfflineMigrationFingerprintDefinition fingerprint = registry.Match(source);
        ImmutableArray<OfflineMigrationStep> ordered = OfflineMigrationPlanValidation.OrderSteps(dag, fingerprint.EntryStepId);
        OfflineMigrationPlanValidation.ValidateTargetAndTool(target, tool);
        OfflineMigrationPlanValidation.ValidateBackup(source, backup, admissionTime, maximumBackupAge);
        var payload = new OfflineMigrationPlan(
            Format,
            OfflineMigrationPlanValidation.Normalize(source),
            fingerprint.Id,
            fingerprint.Version,
            registry.Digest,
            target,
            dag.Id,
            dag.Version,
            OfflineMigrationPlanValidation.Digest(dag with
            {
                Steps = ordered
            }),
            ordered,
            OfflineMigrationPlanValidation.Normalize(backup),
            tool,
            string.Empty);
        return payload with
        {
            ContentDigest = OfflineMigrationPlanValidation.ComputeContentDigest(payload)
        };
    }
}

internal static class OfflineMigrationPlanVerifier
{
    // A completed apply no longer has the pre-migration live shape. Its owner must
    // authenticate the original backup observations and first AttemptStarted journal
    // time before entering this pure closure verifier; payload assertions are not evidence.
    // Fresh current schema and each actual postcondition remain the independent verifier's
    // responsibility. Revalidation here neither executes nor authorizes the old plan.
    internal static VerifiedOfflineMigrationPlan VerifyForCompletedApplyBindings(
        OfflineMigrationPlan plan,
        ReadOnlySpan<byte> observedPlanArtifact,
        CurrentSchemaArtifactReference artifact,
        OfflineMigrationBackupObservation authenticatedBackup,
        CurrentSchemaTargetIdentity currentTarget,
        CurrentSchemaVerifierIdentity retainedPlanTool,
        OfflineMigrationSourceRegistry registry,
        OfflineMigrationDag dag,
        DateTimeOffset recordedFirstApplyAdmissionTime,
        TimeSpan maximumBackupAge)
    {
        OfflineMigrationPlanValidation.RequireText(artifact.Reference, "offline_plan_artifact_reference_invalid");
        OfflineMigrationPlanValidation.RequireDigest(artifact.Sha256, "offline_plan_artifact_digest_invalid");
        if (Convert.ToHexStringLower(SHA256.HashData(observedPlanArtifact)) != artifact.Sha256
            || !observedPlanArtifact.SequenceEqual(OfflineMigrationPlanCodec.Serialize(plan)))
        {
            throw new InvalidOperationException("offline_plan_artifact_bytes_mismatch");
        }

        if (recordedFirstApplyAdmissionTime == default || recordedFirstApplyAdmissionTime.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_plan_apply_admission_time_invalid");
        }

        return Verify(plan, authenticatedBackup.SourceAtCapture, authenticatedBackup, currentTarget,
            retainedPlanTool, registry, dag, recordedFirstApplyAdmissionTime, maximumBackupAge);
    }

    // Rebuild closure from the authority's registry/DAG and fresh observations, not from the
    // payload's assertions. Do not invoke the builder or trust a public "verified" flag.
    internal static VerifiedOfflineMigrationPlan Verify(
        OfflineMigrationPlan plan,
        OfflineMigrationSourceObservation observedSource,
        OfflineMigrationBackupObservation observedBackup,
        CurrentSchemaTargetIdentity currentTarget,
        CurrentSchemaVerifierIdentity currentTool,
        OfflineMigrationSourceRegistry registry,
        OfflineMigrationDag dag,
        DateTimeOffset admissionTime,
        TimeSpan maximumBackupAge)
    {
        if (!string.Equals(plan.Format, OfflineMigrationPlanBuilder.Format, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("offline_plan_format_unknown");
        }

        OfflineMigrationFingerprintDefinition fingerprint = registry.Match(observedSource);
        ImmutableArray<OfflineMigrationStep> expectedSteps = OfflineMigrationPlanValidation.OrderSteps(dag, fingerprint.EntryStepId);
        OfflineMigrationPlanValidation.ValidateTargetAndTool(currentTarget, currentTool);
        OfflineMigrationPlanValidation.ValidateBackup(observedSource, observedBackup, admissionTime, maximumBackupAge);
        if (!OfflineMigrationPlanValidation.Equal(plan.Source, OfflineMigrationPlanValidation.Normalize(observedSource)))
        {
            throw new InvalidOperationException("offline_plan_source_changed");
        }

        if (!OfflineMigrationPlanValidation.Equal(plan.Backup, OfflineMigrationPlanValidation.Normalize(observedBackup)))
        {
            throw new InvalidOperationException("offline_plan_backup_changed");
        }

        if (plan.Target != currentTarget || plan.Tool != currentTool)
        {
            throw new InvalidOperationException("offline_plan_target_or_tool_changed");
        }

        if (plan.SourceFingerprintId != fingerprint.Id || plan.SourceFingerprintVersion != fingerprint.Version
            || plan.SourceRegistryDigest != registry.Digest || plan.DagId != dag.Id || plan.DagVersion != dag.Version
            || plan.DagDigest != OfflineMigrationPlanValidation.Digest(dag with
            {
                Steps = expectedSteps
            })
            || !OfflineMigrationPlanValidation.Equal(plan.OrderedSteps, expectedSteps))
        {
            throw new InvalidOperationException("offline_plan_authority_or_steps_changed");
        }

        OfflineMigrationPlanValidation.RequireDigest(plan.ContentDigest, "offline_plan_digest_invalid");
        if (plan.ContentDigest != OfflineMigrationPlanValidation.ComputeContentDigest(plan))
        {
            throw new InvalidOperationException("offline_plan_digest_mismatch");
        }

        return new VerifiedOfflineMigrationPlan(plan);
    }
}

internal static class OfflineMigrationPlanValidation
{
    internal static void RequireText(string? value, string code)
    {
        if (string.IsNullOrWhiteSpace(value) || value != value.Trim() || value.Any(char.IsControl))
        {
            throw new InvalidOperationException(code);
        }
    }

    internal static void RequireDigest(string? value, string code)
    {
        if (value is null || value.Length != 64 || value.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidOperationException(code);
        }
    }

    internal static void RequireProviders(IEnumerable<CurrentSchemaProviderKind> values)
    {
        CurrentSchemaProviderKind[] actual = values.OrderBy(value => value).ToArray();
        if (!actual.SequenceEqual(Enum.GetValues<CurrentSchemaProviderKind>()))
        {
            throw new InvalidOperationException("offline_plan_provider_closure_invalid");
        }
    }

    internal static void ValidateShape(OfflineMigrationSourceShape shape)
    {
        if (!Enum.IsDefined(shape.Provider))
        {
            throw new InvalidOperationException("offline_plan_provider_unknown");
        }

        RequireText(shape.ExtractorId, "source_extractor_missing");
        RequireText(shape.ExtractorVersion, "source_extractor_version_missing");
        _ = NormalizeFacts(shape.Schema);
        _ = NormalizeFacts(shape.History);
        _ = NormalizeFacts(shape.BusinessShape);
    }

    internal static void ValidateObservation(OfflineMigrationSourceObservation observation)
    {
        RequireText(observation.Database.InstanceId, "source_instance_identity_missing");
        RequireText(observation.Database.DatabaseId, "source_database_identity_missing");
        RequireDigest(observation.ContentDigest, "source_content_digest_invalid");
        ValidateShape(Shape(observation));
    }

    internal static OfflineMigrationSourceShape Shape(OfflineMigrationSourceObservation observation)
        => new(observation.Database.Provider, observation.ExtractorId, observation.ExtractorVersion,
            observation.Schema, observation.History, observation.BusinessShape);

    internal static ImmutableArray<OfflineMigrationFact> NormalizeFacts(ImmutableArray<OfflineMigrationFact> facts)
    {
        if (facts.IsDefault)
        {
            throw new InvalidOperationException("source_observation_category_missing");
        }

        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (OfflineMigrationFact fact in facts)
        {
            RequireText(fact.Name, "source_observation_name_invalid");
            if (fact.Value is null || !names.Add(fact.Name))
            {
                throw new InvalidOperationException("source_observation_duplicate_or_null");
            }
        }

        return facts.OrderBy(fact => fact.Name, StringComparer.Ordinal).ToImmutableArray();
    }

    internal static OfflineMigrationSourceObservation Normalize(OfflineMigrationSourceObservation observation)
        => observation with
        {
            Schema = NormalizeFacts(observation.Schema),
            History = NormalizeFacts(observation.History),
            BusinessShape = NormalizeFacts(observation.BusinessShape)
        };

    internal static OfflineMigrationBackupObservation Normalize(OfflineMigrationBackupObservation backup)
        => backup with
        {
            CapturedAt = backup.CapturedAt.ToUniversalTime(),
            RestoreVerifiedAt = backup.RestoreVerifiedAt.ToUniversalTime(),
            SourceAtCapture = Normalize(backup.SourceAtCapture),
            RestoredSource = Normalize(backup.RestoredSource),
            ArtifactDigests = NormalizeFacts(backup.ArtifactDigests)
        };

    internal static string[] Differences(OfflineMigrationSourceShape expected, OfflineMigrationSourceShape actual)
    {
        var differences = new List<string>();
        if (expected.ExtractorId != actual.ExtractorId || expected.ExtractorVersion != actual.ExtractorVersion)
        {
            differences.Add("extractor_identity_changed");
        }

        Compare("schema", expected.Schema, actual.Schema);
        Compare("history", expected.History, actual.History);
        Compare("business", expected.BusinessShape, actual.BusinessShape);
        return differences.ToArray();

        void Compare(string category, ImmutableArray<OfflineMigrationFact> expectedFacts, ImmutableArray<OfflineMigrationFact> actualFacts)
        {
            var expectedValues = NormalizeFacts(expectedFacts).ToDictionary(fact => fact.Name, fact => fact.Value, StringComparer.Ordinal);
            var actualValues = NormalizeFacts(actualFacts).ToDictionary(fact => fact.Name, fact => fact.Value, StringComparer.Ordinal);
            foreach (string name in expectedValues.Keys.Union(actualValues.Keys, StringComparer.Ordinal).OrderBy(name => name, StringComparer.Ordinal))
            {
                if (!expectedValues.TryGetValue(name, out string? expectedValue))
                {
                    differences.Add($"{category}:extra:{name}={actualValues[name]}");
                }
                else if (!actualValues.TryGetValue(name, out string? actualValue))
                {
                    differences.Add($"{category}:missing:{name}={expectedValue}");
                }
                else if (expectedValue != actualValue)
                {
                    differences.Add($"{category}:changed:{name}:expected={expectedValue}:actual={actualValue}");
                }
            }
        }
    }

    internal static ImmutableArray<OfflineMigrationStep> OrderSteps(OfflineMigrationDag dag, string entryStepId)
    {
        RequireText(dag.Id, "offline_dag_id_missing");
        RequireText(dag.Version, "offline_dag_version_missing");
        if (dag.Steps.IsDefaultOrEmpty)
        {
            throw new InvalidOperationException("offline_dag_empty");
        }

        var steps = new Dictionary<string, OfflineMigrationStep>(StringComparer.Ordinal);
        foreach (OfflineMigrationStep step in dag.Steps)
        {
            RequireText(step.StepId, "offline_step_id_missing");
            RequireText(step.SourcePrecondition, "offline_step_precondition_missing");
            RequireText(step.TargetPostcondition, "offline_step_postcondition_missing");
            RequireText(step.IdempotencyDefinition, "offline_step_idempotency_missing");
            RequireText(step.ResumePolicy.Version, "offline_step_resume_version_missing");
            RequireText(step.ResumePolicy.WatermarkDefinition, "offline_step_watermark_missing");
            RequireText(step.ResumePolicy.ReplayPostcondition, "offline_step_replay_postcondition_missing");
            if (!steps.TryAdd(step.StepId, step) || step.Dependencies.IsDefault
                || step.Dependencies.Distinct(StringComparer.Ordinal).Count() != step.Dependencies.Length
                || step.ResumePolicy.MaximumBatchRows < 0)
            {
                throw new InvalidOperationException("offline_step_duplicate_or_invalid");
            }

            RequireProviders(step.Operations.Select(operation => operation.Provider));
            string? semanticDigest = null;
            foreach (OfflineMigrationProviderOperation operation in step.Operations)
            {
                RequireText(operation.OperationReference, "offline_step_operation_missing");
                RequireDigest(operation.OperationSourceDigest, "offline_step_operation_source_invalid");
                RequireDigest(operation.SemanticDigest, "offline_step_semantic_digest_invalid");
                if (!Enum.IsDefined(operation.Mode)
                    || (operation.Mode == OfflineMigrationExecutionMode.CheckpointedBatch && step.ResumePolicy.MaximumBatchRows == 0)
                    || (semanticDigest is not null && operation.SemanticDigest != semanticDigest))
                {
                    throw new InvalidOperationException("offline_step_provider_semantics_diverge");
                }

                semanticDigest = operation.SemanticDigest;
            }
        }

        if (!steps.ContainsKey(entryStepId))
        {
            throw new InvalidOperationException("offline_dag_entry_missing");
        }

        foreach (OfflineMigrationStep step in steps.Values)
        {
            foreach (string dependency in step.Dependencies)
            {
                RequireText(dependency, "offline_step_dependency_invalid");
                if (!steps.ContainsKey(dependency))
                {
                    throw new InvalidOperationException($"offline_dag_dependency_missing:{step.StepId}:{dependency}");
                }
            }
        }

        var ordered = ImmutableArray.CreateBuilder<OfflineMigrationStep>();
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        while (emitted.Count < steps.Count)
        {
            OfflineMigrationStep? next = steps.Values
                .Where(step => !emitted.Contains(step.StepId) && step.Dependencies.All(emitted.Contains))
                .OrderBy(step => step.StepId, StringComparer.Ordinal).FirstOrDefault();
            if (next is null)
            {
                throw new InvalidOperationException("offline_dag_cycle");
            }

            emitted.Add(next.StepId);
            ordered.Add(next with
            {
                Dependencies = next.Dependencies.OrderBy(value => value, StringComparer.Ordinal).ToImmutableArray(),
                Operations = next.Operations.OrderBy(operation => operation.Provider).ToImmutableArray()
            });
        }

        if (ordered[0].StepId != entryStepId || ordered[0].Dependencies.Length != 0
            || ordered.Skip(1).Any(step => !DependsOnEntry(step.StepId, new HashSet<string>(StringComparer.Ordinal))))
        {
            throw new InvalidOperationException("offline_dag_unreachable_step");
        }

        return ordered.ToImmutable();

        bool DependsOnEntry(string id, HashSet<string> visited)
        {
            if (id == entryStepId)
            {
                return true;
            }

            return visited.Add(id) && steps[id].Dependencies.Any(dependency => DependsOnEntry(dependency, visited));
        }
    }

    internal static void ValidateTargetAndTool(CurrentSchemaTargetIdentity target, CurrentSchemaVerifierIdentity tool)
    {
        RequireText(target.ModelVersion, "offline_target_model_version_missing");
        RequireText(target.ExtractorVersion, "offline_target_extractor_version_missing");
        RequireText(target.GeneratorVersion, "offline_target_generator_version_missing");
        RequireDigest(target.SourceDigest, "offline_target_source_digest_invalid");
        RequireDigest(target.ContentDigest, "offline_target_digest_invalid");
        if (tool.SourceRevision.Length != 40 || tool.SourceRevision.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("offline_tool_source_revision_invalid");
        }

        RequireDigest(tool.WorktreeDigest, "offline_tool_worktree_digest_invalid");
        RequireDigest(tool.ToolchainDigest, "offline_toolchain_digest_invalid");
        RequireDigest(tool.ConfigurationDigest, "offline_configuration_digest_invalid");
    }

    internal static void ValidateBackup(
        OfflineMigrationSourceObservation source,
        OfflineMigrationBackupObservation backup,
        DateTimeOffset admissionTime,
        TimeSpan maximumBackupAge)
    {
        if (backup is null || maximumBackupAge <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_backup_required");
        }

        foreach (CurrentSchemaArtifactReference artifact in new[] { backup.Package, backup.Manifest, backup.RestoreDrill })
        {
            RequireText(artifact.Reference, "offline_backup_reference_missing");
            RequireDigest(artifact.Sha256, "offline_backup_digest_invalid");
        }

        RequireText(backup.BackupOwner, "offline_backup_owner_missing");
        RequireText(backup.BackupOwnerVersion, "offline_backup_owner_version_missing");
        RequireText(backup.CaptureSnapshotId, "offline_backup_snapshot_identity_missing");
        RequireDigest(backup.DatabaseDumpSha256, "offline_backup_dump_digest_invalid");
        RequireDigest(backup.RestoredDatabaseDumpSha256, "offline_backup_restored_dump_digest_invalid");
        if (backup.CapturedAt > admissionTime || backup.RestoreVerifiedAt > admissionTime
            || backup.RestoreVerifiedAt < backup.CapturedAt || admissionTime - backup.CapturedAt > maximumBackupAge)
        {
            throw new InvalidOperationException("offline_backup_stale_or_unverified");
        }

        ValidateObservation(backup.SourceAtCapture);
        ValidateObservation(backup.RestoredSource);
        if (!Equal(Normalize(source), Normalize(backup.SourceAtCapture))
            || backup.RestoredSource.Database.Provider != source.Database.Provider)
        {
            throw new InvalidOperationException("offline_backup_source_database_mismatch");
        }

        if (backup.RestoredSource.Database == source.Database
            || backup.RestoredSource.ContentDigest != source.ContentDigest
            || Differences(Shape(source), Shape(backup.RestoredSource)).Length != 0)
        {
            throw new InvalidOperationException("offline_backup_restore_not_isolated_or_changed");
        }

        ImmutableArray<OfflineMigrationFact> digests = NormalizeFacts(backup.ArtifactDigests);
        string[] required = ["aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads"];
        if (!digests.Select(fact => fact.Name).SequenceEqual(required))
        {
            throw new InvalidOperationException("offline_backup_artifact_closure_invalid");
        }

        foreach (OfflineMigrationFact artifact in digests)
        {
            RequireDigest(artifact.Value, "offline_backup_artifact_digest_invalid");
        }

        string databaseDigest = digests.Single(fact => fact.Name == "database").Value;
        if (backup.DatabaseDumpSha256 != databaseDigest || backup.RestoredDatabaseDumpSha256 != databaseDigest)
        {
            throw new InvalidOperationException("offline_backup_snapshot_dump_binding_mismatch");
        }
    }

    internal static string ComputeContentDigest(OfflineMigrationPlan plan)
        => OfflineMigrationPlanCodec.ComputeContentDigest(plan);

    internal static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value);

    internal static string Digest<T>(T value) => Convert.ToHexStringLower(SHA256.HashData(Serialize(value)));

    internal static bool Equal<T>(T left, T right) => Serialize(left).AsSpan().SequenceEqual(Serialize(right));
}
