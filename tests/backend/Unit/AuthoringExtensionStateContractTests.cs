using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionStateContractTests
{
    [Fact]
    public void MutableBackingArrays_CannotChangeFrozenSnapshotOrPlan()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        byte[] backing = [1, 2];
        ImmutableArray<byte> aliased = ImmutableCollectionsMarshal.AsImmutableArray(backing);
        AuthoringStateSnapshot snapshot = AuthoringExtensionStateContract.Snapshot(AuthoringStateProcessWorker.Scope(package), package.PackageIdentity, 0, [new("old", aliased)]);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(snapshot, AuthoringStateProcessWorker.Scope(next),
            [new(AuthoringStateTransformKind.SetDefault, "default", null, aliased)]);
        AuthoringFencedStateMigration frozen = AuthoringExtensionStateContract.FreezePlan(package, next, plan);
        backing[0] = 99;
        Assert.Equal((byte)1, snapshot.Entries[0].Value[0]);
        Assert.Equal((byte)1, frozen.Transforms[0].DefaultValue[0]);
        AuthoringExtensionStateContract.ValidatePlan(package, next, frozen);
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.ValidatePlan(package, next, plan));
    }

    [Fact]
    public void HugeRepeatedDefaults_RejectBeforeCanonicalHashAllocation()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        AuthoringStateSnapshot snapshot = AuthoringExtensionStateContract.Snapshot(AuthoringStateProcessWorker.Scope(package), package.PackageIdentity, 0, []);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(snapshot, AuthoringStateProcessWorker.Scope(next));
        var transform = new AuthoringStateTransform(AuthoringStateTransformKind.SetDefault, "default", null,
            ImmutableArray.CreateRange(new byte[AuthoringExtensionStateContract.MaximumValueBytes]));
        plan = plan with
        {
            Transforms = ImmutableArray.CreateRange(Enumerable.Repeat(transform, 1000))
        };
        AuthoringExtensionContractException failure = Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionStateContract.ValidatePlan(package, next, plan));
        Assert.Equal("state_migration_default_bytes_unbounded", failure.Message);
        Assert.Equal("state_migration_default_bytes_unbounded", Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionStateContract.ComputeContentSha256(plan)).Message);
    }

    [Fact]
    public void SnapshotCodec_BindsScopeRevisionAndOrdinalEntries()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(package);
        AuthoringStateSnapshot first = AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 1,
            [new("z", [2]), new("a", [1])]);
        AuthoringStateSnapshot reordered = AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 1,
            [new("a", [1]), new("z", [2])]);
        Assert.Equal(first.ContentSha256, reordered.ContentSha256);
        byte[] encoded = AuthoringExtensionStateContract.Encode(first);
        Assert.Equal(encoded, AuthoringExtensionStateContract.Encode(AuthoringExtensionStateContract.DecodeSnapshot(encoded)));
        Assert.NotEqual(first.ContentSha256,
            AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 2, first.Entries).ContentSha256);
        Assert.NotEqual(AuthoringExtensionStateContract.ScopeId(scope), AuthoringExtensionStateContract.ScopeId(scope with
        {
            DocumentId = null
        }));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.DecodeSnapshot([.. encoded, (byte)' ']));
        string tampered = Encoding.UTF8.GetString(encoded).Replace("\"revision\":1", "\"revision\":2", StringComparison.Ordinal);
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.DecodeSnapshot(Encoding.UTF8.GetBytes(tampered)));
    }

    [Fact]
    public void PlanHash_BindsEveryAuthorityAndOrderedTransform()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        AuthoringStateSnapshot source = AuthoringExtensionStateContract.Snapshot(AuthoringStateProcessWorker.Scope(package), package.PackageIdentity, 1, [new("old", [1])]);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(source, AuthoringStateProcessWorker.Scope(next));
        AuthoringExtensionStateContract.ValidatePlan(package, next, plan);
        AuthoringFencedStateMigration[] mutations =
        [
            plan with { ExpectedFromRevision = 2 }, plan with { ExpectedToRevision = 1 },
            plan with { SourceContentSha256 = new string('c', 64) }, plan with { MaximumBytes = 100 },
            plan with { BackupReference = "other" }, plan with { RollbackReference = "other" },
            plan with { To = plan.To with { UserId = "other" } }, plan with { ContractVersion = 2 },
            plan with { Transforms = [new(AuthoringStateTransformKind.DeleteExtensionKey, "old", null, [])] }
        ];
        foreach (AuthoringFencedStateMigration mutated in mutations)
        {
            if (mutated.ContractVersion == 1)
            {
                Assert.NotEqual(plan.ContentSha256, AuthoringExtensionStateContract.ComputeContentSha256(mutated));
            }
            else
            {
                Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.ComputeContentSha256(mutated));
            }
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.ValidatePlan(package, next, mutated));
        }
    }

    [Fact]
    public void Entries_RejectDuplicateUnboundedAndMalformedKeys()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(package);
        AuthoringStateEntry[][] invalid =
        [
            [new("same", []), new("same", [])], [new(" bad", [])], [new("bad\0key", [])],
            [new("\ud800", [])], [new("key", default)],
            [new("key", ImmutableArray.CreateRange(new byte[AuthoringExtensionStateContract.MaximumValueBytes + 1]))]
        ];
        foreach (AuthoringStateEntry[] entries in invalid)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 0, entries));
        }
    }
}
