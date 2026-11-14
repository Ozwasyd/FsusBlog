using System.Text.Json;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task NotifyAsync(NpgsqlConnection connection, string recipient, string eventId, Stream input, CancellationToken ct)
    {
        if (!Guid.TryParseExact(recipient, "D", out var account) || account == Guid.Empty)
            throw new ArgumentException("Set ACCOUNT_ID to the intended user's database UUID.");
        var message = await ReadNoticeAsync(input, ct);
        await CurrentSchema.VerifyAsync(connection, ct);

        await using var transaction = await connection.BeginTransactionAsync(ct);
        InboxNoticeReceipt receipt;
        try
        {
            var inbox = new InboxStore(connection, transaction, account);
            var sent = await inbox.SendNoticeAsync(eventId, message.Subject, message.Body, ct);
            receipt = new InboxNoticeReceipt(account, sent.Message.ConversationId, sent.Message.Id, sent.Replayed);
        }
        catch (BusinessException error)
        {
            throw new InvalidOperationException(error.Message, error);
        }

        await transaction.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(receipt, Json));
    }

    private static async Task<(string Subject, string Body)> ReadNoticeAsync(Stream input, CancellationToken ct)
    {
        const int maximum = 96 * 1024;
        var bytes = new byte[maximum + 1];
        int used = 0;
        while (used < bytes.Length)
        {
            int count = await input.ReadAsync(bytes.AsMemory(used), ct);
            if (count == 0) break;
            used += count;
        }
        if (used > maximum) throw new ArgumentException("Notice input exceeds 96 KiB.");

        using var document = JsonDocument.Parse(bytes.AsMemory(0, used), new JsonDocumentOptions { MaxDepth = 2 });
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Expected an object with subject and body strings.");
        string? subject = null;
        string? body = null;
        foreach (var field in document.RootElement.EnumerateObject())
        {
            if (field.Value.ValueKind != JsonValueKind.String)
                throw new ArgumentException("Expected subject and body strings.");
            switch (field.Name)
            {
                case "subject" when subject is null:
                    subject = field.Value.GetString();
                    break;
                case "body" when body is null:
                    body = field.Value.GetString();
                    break;
                default:
                    throw new ArgumentException("Unexpected or repeated notice field.");
            }
        }
        if (subject is null || body is null) throw new ArgumentException("Set both subject and body.");
        return (subject, body);
    }

    private sealed record InboxNoticeReceipt(Guid AccountId, long ConversationId, long MessageId, bool Replayed);
}
