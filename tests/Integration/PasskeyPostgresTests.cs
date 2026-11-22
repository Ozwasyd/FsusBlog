using System.Buffers.Binary;
using System.Formats.Cbor;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.WebUtilities;
using static FsusBlog.V2.Integration.Tests.BusinessAssert;

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
        await Denied(() => service.BeginProvision(ticket, ct));
        await Denied(() => new Store(fixture.DataSource).SignIn(ticket, ct));

        // These are invalid bytes. Verification can never create a credential or session from this request.
        var rawId = new byte[] { 42 };
        var completion = new PasskeyProvisionRequest(token, "Kg", rawId, [1], [1], []);
        await Denied(() => service.CompleteProvision(completion, null, ct));
        await Denied(() => service.CompleteProvision(completion, new string('A', 43), ct));
        await using (var count = Store.Sql(db, null, "select count(*) from public.passkey_challenge where user_id=$1", id))
            Assert.Equal(1L, await count.ExecuteScalarAsync(ct));

        await using (var revoke = Store.Sql(db, null, "update public.blog_user set generation=generation+1 where id=$1", id))
            await revoke.ExecuteNonQueryAsync(ct);
        await Denied(() => service.CompleteProvision(completion, registration.Binding, ct));
        await Denied(() => service.CompleteProvision(completion, registration.Binding, ct));
        await using var remaining = Store.Sql(db, null, """
            select (select count(*) from public.passkey_challenge where user_id=$1)
                + (select count(*) from public.passkey_credential where user_id=$1)
                + (select count(*) from public.user_session where user_id=$1)
            """, id);
        Assert.Equal(0L, await remaining.ExecuteScalarAsync(ct));
    }

    [PostgresFact]
    public async Task UnifiedPasskeyLoginRoutesReaderAndAdminToDistinctSessions()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        const string host = "blog.example.test";
        const string origin = "https://" + host;
        using var readerKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var adminKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var readerCredId = RandomNumberGenerator.GetBytes(32);
        var adminCredId = RandomNumberGenerator.GetBytes(32);
        var readerHandle = RandomNumberGenerator.GetBytes(32);
        var adminHandle = RandomNumberGenerator.GetBytes(32);
        var readerUserId = Guid.NewGuid();
        var adminPrincipalId = Guid.NewGuid();

        await FixtureSql.ExecuteAsync(db, null, ct,
            "insert into public.blog_user(id,name,enabled,generation) values($1,'unified-reader',true,1)", readerUserId);
        await FixtureSql.ExecuteAsync(db, null, ct,
            "insert into public.passkey_subject(user_id,user_handle) values($1,$2)", readerUserId, readerHandle);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.passkey_credential(credential_id,user_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, readerCredId, readerUserId, EncodeCoseEs256PublicKey(readerKey));

        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_principal(id,handle,user_handle,enabled,generation,generation_changed_at)
            values($1,'unified-admin',$2,true,1,clock_timestamp()-interval '1 minute')
            """, adminPrincipalId, adminHandle);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, adminCredId, adminPrincipalId, EncodeCoseEs256PublicKey(adminKey));

        static void AttachHttps(HttpRequestMessage request)
        {
            request.Headers.Host = host;
            request.Headers.Add("X-Forwarded-Proto", "https");
            request.Headers.Add("X-Forwarded-For", "198.51.100.30");
        }

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = origin,
        }, AttachHttps))
        {
            // 1. Reader Passkey on unified /api/binary/auth/passkey/login/complete issues ONLY reader cookie & "anonymous_account"
            var readerBegin = await BeginLogin(server);
            var readerComplete = await CompleteLogin(server, BuildLoginAssertionFrame(
                readerBegin.Token, readerBegin.Challenge, host, origin, readerCredId, readerHandle, readerKey, signCount: 1, rememberMe: false));
            Assert.Equal(HttpStatusCode.OK, readerComplete.Status);
            Assert.Equal("anonymous_account", ReadAuthLoginRole(readerComplete.Body));
            var readerCookie = Assert.Single(readerComplete.Cookies, c => c.StartsWith("fsus-v2-session=", StringComparison.Ordinal));
            Assert.DoesNotContain(readerComplete.Cookies, c => c.StartsWith("__Host-FsusAdminSession=", StringComparison.Ordinal));
            Assert.Equal(HttpStatusCode.OK, await Probe(server, WireRoutes.Session, readerCookie));
            Assert.Equal(HttpStatusCode.Unauthorized, await Probe(server, WireRoutes.AdminSession, readerCookie));
            Assert.Equal(HttpStatusCode.Unauthorized, await Probe(server, WireRoutes.AuthoringSession, readerCookie));

            // 2. Admin Passkey on the EXACT SAME unified endpoint issues ONLY admin cookie & "administrator" (and ignores RememberMe)
            var adminBegin = await BeginLogin(server);
            var adminComplete = await CompleteLogin(server, BuildLoginAssertionFrame(
                adminBegin.Token, adminBegin.Challenge, host, origin, adminCredId, adminHandle, adminKey, signCount: 1, rememberMe: true));
            Assert.Equal(HttpStatusCode.OK, adminComplete.Status);
            Assert.Equal("administrator", ReadAuthLoginRole(adminComplete.Body));
            var adminCookie = Assert.Single(adminComplete.Cookies, c => c.StartsWith("__Host-FsusAdminSession=", StringComparison.Ordinal));
            Assert.DoesNotContain(adminComplete.Cookies, c => c.StartsWith("fsus-v2-session=", StringComparison.Ordinal));
            Assert.DoesNotContain(adminComplete.Cookies, c => c.StartsWith("__Secure-FsusSiteRefresh=", StringComparison.Ordinal));
            Assert.Equal(HttpStatusCode.OK, await Probe(server, WireRoutes.AdminSession, adminCookie));
            Assert.Equal(HttpStatusCode.OK, await Probe(server, WireRoutes.AuthoringSession, adminCookie));
            Assert.Equal(HttpStatusCode.Unauthorized, await Probe(server, WireRoutes.Session, adminCookie));

            // 3. Challenge started before admin generation_changed_at is rejected fail-closed
            var staleBegin = await BeginLogin(server);
            await FixtureSql.ExecuteAsync(db, null, ct,
                "update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp()+interval '1 minute' where id=$1",
                adminPrincipalId);
            var staleComplete = await CompleteLogin(server, BuildLoginAssertionFrame(
                staleBegin.Token, staleBegin.Challenge, host, origin, adminCredId, adminHandle, adminKey, signCount: 2, rememberMe: false));
            Assert.Equal(HttpStatusCode.Unauthorized, staleComplete.Status);
            await FixtureSql.ExecuteAsync(db, null, ct,
                "update public.admin_principal set generation_changed_at=clock_timestamp()-interval '1 minute' where id=$1",
                adminPrincipalId);
        }

        // 4. When FSUSBLOG_ADMIN_ORIGIN="" disables admin, admin Passkey fails closed (401) on unified login
        await using (var publicOnly = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = origin,
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
        }, AttachHttps))
        {
            var disabledBegin = await BeginLogin(publicOnly);
            var disabledComplete = await CompleteLogin(publicOnly, BuildLoginAssertionFrame(
                disabledBegin.Token, disabledBegin.Challenge, host, origin, adminCredId, adminHandle, adminKey, signCount: 3, rememberMe: false));
            Assert.Equal(HttpStatusCode.Unauthorized, disabledComplete.Status);
        }

        async Task<(string Token, byte[] Challenge)> BeginLogin(ServerProcess server)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, WireRoutes.PasskeyLoginBegin);
            AttachHttps(req);
            req.Headers.Add("Origin", origin);
            using var resp = await server.Client.SendAsync(req, ct);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            var payload = Aeds.Decode(await resp.Content.ReadAsByteArrayAsync(ct), FrameType.PasskeyLoginBegin).ToArray();
            var token = Encoding.ASCII.GetString(payload, WireLayouts.PasskeyLoginBeginTokenOffset, 43);
            var blobOffset = WireLayouts.PasskeyLoginBeginSize + 4;
            var challengeRefOffset = WireLayouts.PasskeyLoginBeginTokenOffset + WireLayouts.PasskeyTokenSize + WireLayouts.PasskeySliceSize;
            var challengeOffset = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(challengeRefOffset));
            var challengeLength = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(challengeRefOffset + 4));
            return (token, payload.AsSpan(blobOffset + challengeOffset, challengeLength).ToArray());
        }

        async Task<(HttpStatusCode Status, byte[] Body, string[] Cookies)> CompleteLogin(ServerProcess server, byte[] frame)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, WireRoutes.PasskeyLoginComplete)
            {
                Content = new ByteArrayContent(frame)
            };
            req.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(Aeds.ContentType);
            AttachHttps(req);
            req.Headers.Add("Origin", origin);
            using var resp = await server.Client.SendAsync(req, ct);
            var cookies = resp.Headers.TryGetValues("Set-Cookie", out var values) ? values.ToArray() : [];
            return (resp.StatusCode, await resp.Content.ReadAsByteArrayAsync(ct), cookies);
        }

        async Task<HttpStatusCode> Probe(ServerProcess server, string route, string setCookie)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, route);
            AttachHttps(req);
            req.Headers.Add("Cookie", setCookie.Split(';', 2)[0]);
            using var resp = await server.Client.SendAsync(req, ct);
            return resp.StatusCode;
        }
    }

    private static string ReadAuthLoginRole(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.AuthLoginFlow);
        Assert.Equal(WireLayouts.PasskeyAuthLoginFlowSize, payload.Length);
        return Encoding.UTF8.GetString(payload.Slice(8, 64)).TrimEnd('\0');
    }

    private static byte[] EncodeCoseEs256PublicKey(ECDsa key)
    {
        var p = key.ExportParameters(includePrivateParameters: false);
        var writer = new CborWriter();
        writer.WriteStartMap(5);
        writer.WriteInt32(1); writer.WriteInt32(2);    // kty: EC2
        writer.WriteInt32(3); writer.WriteInt32(-7);   // alg: ES256
        writer.WriteInt32(-1); writer.WriteInt32(1);   // crv: P-256
        writer.WriteInt32(-2); writer.WriteByteString(p.Q.X!);
        writer.WriteInt32(-3); writer.WriteByteString(p.Q.Y!);
        writer.WriteEndMap();
        return writer.Encode();
    }

    private static byte[] BuildLoginAssertionFrame(string token, byte[] challenge, string rpId, string origin,
        byte[] rawId, byte[] userHandle, ECDsa key, uint signCount, bool rememberMe)
    {
        var clientData = JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "webauthn.get",
            challenge = WebEncoders.Base64UrlEncode(challenge),
            origin,
            crossOrigin = false,
        });
        var authData = new byte[37];
        SHA256.HashData(Encoding.UTF8.GetBytes(rpId), authData.AsSpan(0, 32));
        authData[32] = 0x05; // UP | UV
        BinaryPrimitives.WriteUInt32BigEndian(authData.AsSpan(33, 4), signCount);
        var signed = new byte[authData.Length + 32];
        authData.CopyTo(signed, 0);
        SHA256.HashData(clientData, signed.AsSpan(authData.Length));
        var signature = key.SignData(signed, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        byte[][] fields =
        [
            Encoding.UTF8.GetBytes(WebEncoders.Base64UrlEncode(rawId)),
            rawId,
            clientData,
            authData,
            signature,
            userHandle,
        ];
        var blobStart = WireLayouts.PasskeyLoginCompleteSize + 4;
        var blobSize = fields.Sum(f => f.Length);
        var payload = new byte[blobStart + blobSize];
        payload[0] = rememberMe ? (byte)1 : (byte)0;
        payload[1] = 1; // discoverable userHandle present
        Encoding.ASCII.GetBytes(token, payload.AsSpan(8, WireLayouts.PasskeyTokenSize));
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(WireLayouts.PasskeyLoginCompleteSize), blobSize);
        var offset = 0;
        for (var i = 0; i < fields.Length; i++)
        {
            var slot = 8 + WireLayouts.PasskeyTokenSize + i * WireLayouts.PasskeySliceSize;
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(slot), offset);
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(slot + 4), fields[i].Length);
            fields[i].CopyTo(payload, blobStart + offset);
            offset += fields[i].Length;
        }
        return Aeds.Encode(FrameType.PasskeyLoginCompleteRequest, payload);
    }

    private static string ReadToken(byte[] frame, FrameType type, int offset) =>
        Encoding.ASCII.GetString(Aeds.Decode(frame, type).Slice(offset, 43));
}
