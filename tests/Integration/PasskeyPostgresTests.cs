using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PasskeyPostgresTests
{
    [PostgresFact]
    public async Task OneUseProvisioningTicketIsBoundToBrowserAndAccountGeneration()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost:54822"), "localhost"));
        var key = RandomNumberGenerator.GetBytes(32);
        var digest = SHA256.HashData(key);
        var ticket = Convert.ToHexStringLower(key);
        var id = Guid.NewGuid();
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using (var insert = Store.Sql(db, null,
            "insert into public.blog_user(id,name,enabled,generation) values ($1,'Passkey fixture',true,1)", id))
            await insert.ExecuteNonQueryAsync(ct);
        await using (var insert = Store.Sql(db, null,
            "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,clock_timestamp()+interval '5 minutes')", digest, id))
            await insert.ExecuteNonQueryAsync(ct);

        var registration = await service.BeginProvision(ticket, ct);
        var token = ReadToken(registration.Frame, FrameType.PasskeyRegisterBegin, WireLayouts.PasskeyRegisterBeginTokenOffset);
        await ExpectUnauthorized(() => service.BeginProvision(ticket, ct));
        await ExpectUnauthorized(() => new Store(fixture.DataSource).SignIn(ticket, ct));

        // These are invalid bytes. Verification can never create a credential or session from this request.
        var rawId = new byte[] { 42 };
        var completion = new PasskeyProvisionRequest(token, "Kg", rawId, [1], [1], []);
        await ExpectUnauthorized(() => service.CompleteProvision(completion, null, ct));
        await ExpectUnauthorized(() => service.CompleteProvision(completion, new string('A', 43), ct));
        await using (var count = Store.Sql(db, null, "select count(*) from public.passkey_challenge where user_id=$1", id))
            Assert.Equal(1L, await count.ExecuteScalarAsync(ct));

        await using (var revoke = Store.Sql(db, null, "update public.blog_user set generation=generation+1 where id=$1", id))
            await revoke.ExecuteNonQueryAsync(ct);
        await ExpectUnauthorized(() => service.CompleteProvision(completion, registration.Binding, ct));
        await ExpectUnauthorized(() => service.CompleteProvision(completion, registration.Binding, ct));
        await using var remaining = Store.Sql(db, null, """
            select (select count(*) from public.passkey_challenge where user_id=$1)
                + (select count(*) from public.passkey_credential where user_id=$1)
                + (select count(*) from public.user_session where user_id=$1)
            """, id);
        Assert.Equal(0L, await remaining.ExecuteScalarAsync(ct));
    }

    private static async Task ExpectUnauthorized(Func<Task> action)
    {
        var error = await Assert.ThrowsAsync<BusinessException>(action);
        Assert.Equal(Rejection.Unauthorized, error.Rejection);
    }

    private static string ReadToken(byte[] frame, FrameType type, int offset) =>
        Encoding.ASCII.GetString(Aeds.Decode(frame, type).Slice(offset, 43));
}
