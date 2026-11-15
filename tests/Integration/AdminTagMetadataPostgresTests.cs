using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminTagMetadataPostgresTests
{
    [PostgresFact]
    public async Task UnusedTagChangesRetainAliasesAndAdvanceOnlyTheTaxonomyWatermark()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (id, token, _) = await FixtureSql.AdminAsync(db, ct, "tag-editor", 10, [1], [2]);
        await Sql("insert into public.tag(id,name,description) values(1,'Ancienne','Original description'),(2,'Other',null),(3,'Peer',null)");
        await Sql("insert into public.tag_url_name values('ARCHIVED',2)");

        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, requireAdminTagMetadata: true);
        var admin = new AdminPasskeyStore(fixture.DataSource, lease, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var publications = Project();
        await publications.Refresh(ct);
        var baseline = publications.Snapshot!;
        Assert.Equal(0L, baseline.TaxonomyEpoch);
        Assert.Equal(1, baseline.Taxonomy.TagByName("Ancienne"));
        await Assert.ThrowsAsync<BusinessException>(() => admin.ReadTagMetadata(token, 1, ct));
        await Sql("insert into public.admin_permission values($1,$2)", id, CurrentSchema.ArticleWritePermission);

        var pow = new ScopedPow(TimeProvider.System);
        var first = new AdminTagMetadataCommand(1, 0, Guid.NewGuid(), "Cafe\u0301 nouveau", " Changed description. ");
        var receipt = Wire.DecodeAdminTagMetadata(await Execute(first, Proof(first)));
        Assert.Equal(new AdminTagMetadata(1, 1, "Café nouveau", "Changed description.", true), receipt);
        var changed = publications.Snapshot!;
        Assert.NotEqual(baseline.Generation, changed.Generation);
        Assert.Equal(baseline.Watermark, changed.Watermark);
        Assert.Equal(1L, changed.TaxonomyEpoch);
        Assert.Equal(1, changed.Taxonomy.TagByName("ancienne"));
        Assert.Equal(1, changed.Taxonomy.TagByName("CAFE\u0301 NOUVEAU"));
        Assert.Contains("Changed description.", System.Text.Encoding.UTF8.GetString(changed.Taxonomy.ById(true, 1)!.Value.Html));
        Assert.Equal(receipt, Wire.DecodeAdminTagMetadata(await Execute(first, null)));
        Assert.Same(changed, publications.Snapshot);

        var stale = first with { RequestId = Guid.NewGuid(), Name = "Too late" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(stale, Proof(stale)));
        var reserved = first with { Id = 3, RequestId = Guid.NewGuid(), Name = "Archived" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(reserved, Proof(reserved)));
        var collision = first with { Id = 3, RequestId = Guid.NewGuid(), Name = "CAFÉ NOUVEAU" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(collision, Proof(collision)));
        var wrongProof = first with { Id = 2, RequestId = Guid.NewGuid(), Name = "Other changed" };
        await Assert.ThrowsAsync<ScopedPowFailure>(() => Execute(wrongProof, Proof(wrongProof with { Name = "Different intent" })));
        var cleared = first with { RequestId = Guid.NewGuid(), ExpectedRevision = 1, Description = "    " };
        var clearProof = Proof(cleared);
        var clear = Wire.DecodeAdminTagMetadata(await Execute(cleared, clearProof));
        Assert.Equal(new AdminTagMetadata(1, 2, "Café nouveau", "", true), clear);
        var epochTwo = publications.Snapshot!;
        Assert.NotEqual(changed.Generation, epochTwo.Generation);
        Assert.Same(epochTwo, publications.Snapshot);
        Assert.Equal(2L, await Number("select count(*) from public.tag_url_name where tag_id=1"));
        Assert.Equal(0L, await Number("select count(*) from public.blog_outbox"));
        var noWrite = cleared with { RequestId = Guid.NewGuid(), ExpectedRevision = 2 };
        var noOp = Wire.DecodeAdminTagMetadata(await Execute(noWrite, Proof(noWrite)));
        Assert.False(noOp.Changed);
        Assert.Same(epochTwo, publications.Snapshot);
        Assert.Equal(3L, await Number("select count(*) from public.admin_tag_metadata_command"));
        Assert.Equal(2L, await Number("select count(*) from public.admin_tag_metadata_command where changed"));

        // Same database, newly built instance, no administrator feature detection from the request path.
        var restarted = Project();
        await restarted.Refresh(ct);
        Assert.Equal(epochTwo.Generation, restarted.Snapshot!.Generation);
        Assert.Equal(1, restarted.Snapshot.Taxonomy.TagByName("Ancienne"));
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", id);
        await Assert.ThrowsAsync<BusinessException>(() => Execute(first, null));

        Publications Project() => new(fixture.DataSource, new WebPages("<html><head></head><!--fsus-public-content--></html>"),
            NullLogger<Publications>.Instance, lease);

        Task<byte[]> Execute(AdminTagMetadataCommand change, string? proof)
        {
            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = IPAddress.Loopback;
            if (proof is not null) ctx.Request.Headers[WireHeaders.PowProof] = proof;
            return publications.AdministrativePublication(invalidate => admin.ChangeTagMetadata(token, change,
                Wire.EncodeAdminTagMetadataCommand(change), ctx, pow, invalidate, ct), ct);
        }

        string Proof(AdminTagMetadataCommand change)
        {
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            var challenge = pow.Issue(PowScope.AdminTagMetadata, change.Id.ToString(CultureInfo.InvariantCulture), token,
                IPAddress.Loopback, nonce, Wire.EncodeAdminTagMetadataCommand(change));
            return SolveProof(challenge, nonce, ct);
        }

        Task Sql(string text, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, text, values);

        async Task<long> Number(string text)
        {
            return (long)(await FixtureSql.ScalarAsync(db, null, ct, text))!;
        }
    }

    internal static string SolveProof(PowChallenge challenge, string clientNonce, CancellationToken ct)
    {
        var number = 0;
        while (!ScopedPow.HasWork(challenge.Salt, number.ToString(CultureInfo.InvariantCulture), clientNonce, challenge.Difficulty))
        {
            ct.ThrowIfCancellationRequested();
            ++number;
        }

        using var output = new MemoryStream();
        using var writer = new BinaryWriter(output);
        writer.Write("FPOW\u0001"u8);
        writer.Write(challenge.Difficulty);
        writer.Write(challenge.Timestamp);
        foreach (var value in new[] { challenge.Salt, number.ToString(CultureInfo.InvariantCulture), challenge.Signature, clientNonce })
        {
            writer.Write((ushort)value.Length);
            writer.Write(System.Text.Encoding.ASCII.GetBytes(value));
        }
        writer.Flush();
        return Convert.ToBase64String(output.ToArray());
    }
}
