using Serilog.Core;
using Serilog.Events;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditSerilogEnricher(AuditLogEventMapper mapper) : ILogEventEnricher
{
    private readonly AuditLogEventMapper _mapper = mapper;

    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        if (!AuditLogEventMapper.IsAuditCandidate(logEvent))
        {
            return;
        }

        AuditRecord? mappedRecord = TryGetMappedRecord(logEvent);
        string? source = TryGetString(logEvent, AuditPropertyNames.Source);
        if (string.IsNullOrWhiteSpace(source))
        {
            AuditRecord? record = mappedRecord ?? _mapper.Map(logEvent);
            if (record is null)
            {
                return;
            }

            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(AuditPropertyNames.MappedRecord, record));
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(AuditPropertyNames.Source, record.Source));
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(AuditPropertyNames.Type, record.Type));
            return;
        }

        string? type = TryGetString(logEvent, AuditPropertyNames.Type);
        if (string.IsNullOrWhiteSpace(type))
        {
            AuditRecord? record = mappedRecord ?? _mapper.Map(logEvent);
            if (record is null)
            {
                return;
            }

            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(AuditPropertyNames.MappedRecord, record));
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(AuditPropertyNames.Type, record.Type));
        }
    }

    private static string? TryGetString(LogEvent logEvent, string propertyName)
        => logEvent.Properties.TryGetValue(propertyName, out LogEventPropertyValue? value)
           && value is ScalarValue { Value: not null } scalar
            ? Convert.ToString(scalar.Value)
            : null;

    internal static AuditRecord? TryGetMappedRecord(LogEvent logEvent)
        => logEvent.Properties.TryGetValue(AuditPropertyNames.MappedRecord, out LogEventPropertyValue? value)
           && value is ScalarValue { Value: AuditRecord record }
            ? record
            : null;
}

public sealed class AuditSerilogSink(AuditLogChannel channel, AuditLogEventMapper mapper) : ILogEventSink
{
    private readonly AuditLogChannel _channel = channel;
    private readonly AuditLogEventMapper _mapper = mapper;

    public void Emit(LogEvent logEvent)
    {
        AuditRecord? record = AuditSerilogEnricher.TryGetMappedRecord(logEvent);
        if (record is null && !AuditLogEventMapper.IsAuditCandidate(logEvent))
        {
            return;
        }

        record ??= _mapper.Map(logEvent);
        if (record is null)
        {
            return;
        }

        _channel.TryWrite(record);
    }
}
