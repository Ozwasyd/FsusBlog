using System.Buffers.Binary;

namespace FsusBlog.V2.Contracts;

public enum AdminSignInState : byte { Current = 1, Ended = 2, Expired = 3 }

public sealed record AdminSignIn(long StartedAt, long ExpiresAt, long EndedAt, AdminSignInState State);

public sealed record AdminSignInHistorySnapshot(long Generation, IReadOnlyList<AdminSignIn> SignIns);

public static partial class Wire
{
    public static byte[] EncodeAdminSignInHistory(AdminSignInHistorySnapshot value)
    {
        if (value.Generation <= 0 || value.SignIns.Count > 50)
            throw new ProtocolException("Invalid administrator sign-in history.");

        const int headerSize = sizeof(long) + sizeof(int);
        const int rowSize = sizeof(long) * 3 + sizeof(byte);
        Span<byte> payload = stackalloc byte[headerSize + value.SignIns.Count * rowSize];
        BinaryPrimitives.WriteInt64LittleEndian(payload, value.Generation);
        BinaryPrimitives.WriteInt32LittleEndian(payload[sizeof(long)..], value.SignIns.Count);

        for (var index = 0; index < value.SignIns.Count; index++)
        {
            var signIn = value.SignIns[index];
            var valid = signIn.State switch
            {
                AdminSignInState.Current => index == 0 && signIn.EndedAt == 0,
                AdminSignInState.Ended => signIn.EndedAt >= signIn.StartedAt && signIn.EndedAt < signIn.ExpiresAt,
                AdminSignInState.Expired => signIn.EndedAt == signIn.ExpiresAt,
                _ => false
            };
            if (!valid || signIn.StartedAt <= 0 || signIn.ExpiresAt <= signIn.StartedAt || signIn.ExpiresAt > 8_640_000_000_000_000L)
                throw new ProtocolException("Invalid administrator sign-in interval.");

            var row = payload[(headerSize + index * rowSize)..];
            BinaryPrimitives.WriteInt64LittleEndian(row, signIn.StartedAt);
            BinaryPrimitives.WriteInt64LittleEndian(row[sizeof(long)..], signIn.ExpiresAt);
            BinaryPrimitives.WriteInt64LittleEndian(row[(sizeof(long) * 2)..], signIn.EndedAt);
            row[sizeof(long) * 3] = (byte)signIn.State;
        }

        return Aeds.Encode(FrameType.AdminSignInHistory, payload);
    }
}
