using System.Text.Json;
using System.Text.Json.Nodes;

namespace FsusBlog.OpenApiObservation;

internal static class OpenApiProjectionWriter
{
    public static string Write(ObservationDocument observation)
    {
        var paths = new JsonObject();
        foreach (ObservationOperation op in observation.Operations
            .OrderBy(static item => item.Path, StringComparer.Ordinal)
            .ThenBy(static item => item.Method, StringComparer.Ordinal))
        {
            if (paths[op.Path] is not JsonObject pathItem)
            {
                pathItem = new JsonObject();
                paths[op.Path] = pathItem;
            }

            string method = op.Method.ToLowerInvariant();
            if (pathItem.ContainsKey(method))
            {
                throw new InvalidOperationException($"duplicate OpenAPI method/path {op.Method} {op.Path}");
            }

            var responses = new JsonObject();
            foreach (OperationResponseContract response in op.Responses.OrderBy(static item => item.Status))
            {
                if (response.Status is not int status)
                {
                    throw new InvalidOperationException($"{op.OperationId} response status must be explicit");
                }
                if (responses.ContainsKey(status.ToString(System.Globalization.CultureInfo.InvariantCulture)))
                {
                    throw new InvalidOperationException($"{op.OperationId} duplicate response status {status}");
                }
                responses[status.ToString(System.Globalization.CultureInfo.InvariantCulture)] = new JsonObject
                {
                    ["description"] = response.Kind == "success"
                        ? $"{op.ResponseFrame} AEDS frame"
                        : $"{op.ErrorFrame} AEDS error frame ({status})",
                    ["content"] = BinaryContent()
                };
            }

            var operation = new JsonObject
            {
                ["operationId"] = op.OperationId,
                ["tags"] = new JsonArray("Binary"),
                ["summary"] = op.Path.Replace("/api/binary", string.Empty, StringComparison.Ordinal),
                ["responses"] = responses,
                ["x-fsus-protocol"] = op.Protocol,
                ["x-fsus-aeds-version"] = op.AedsVersion,
                ["x-fsus-request-frame"] = op.RequestFrame is null ? null : JsonValue.Create(op.RequestFrame),
                ["x-fsus-response-frame"] = op.ResponseFrame,
                ["x-fsus-error-frame"] = op.ErrorFrame,
                ["x-fsus-auth"] = op.Auth,
                ["x-fsus-credential-policy"] = op.CredentialPolicy,
                ["x-fsus-pow"] = op.Pow,
                ["x-fsus-content-type"] = "application/octet-stream",
                ["x-fsus-success-status"] = op.SuccessStatus,
                ["x-fsus-cache"] = op.Cache,
                ["x-fsus-rate-limit"] = op.RateLimit,
                ["x-fsus-permission"] = op.Permission
            };
            operation["x-fsus-request-contract"] = JsonSerializer.SerializeToNode(op.Request);
            operation["x-fsus-response-contracts"] = JsonSerializer.SerializeToNode(op.Responses);
            operation["x-fsus-public-error-refs"] = JsonSerializer.SerializeToNode(op.PublicErrorRefs);
            operation["x-fsus-public-error-statuses"] = JsonSerializer.SerializeToNode(op.PublicErrorStatuses);
            operation["x-fsus-public-error-status-evidence"] = JsonSerializer.SerializeToNode(op.PublicErrorStatusEvidence);
            operation["x-fsus-public-error-ref-state"] = op.PublicErrorRefState;
            operation["x-fsus-error-authority-behavior"] = op.ErrorAuthorityBehaviorId;
            operation["x-fsus-result-placement"] = op.ResultPlacement;
            operation["x-fsus-protocol-state"] = op.ProtocolState;
            if (!string.IsNullOrWhiteSpace(op.SourceIdentity))
            {
                operation["x-fsus-source-identity"] = op.SourceIdentity;
            }

            pathItem[method] = operation;
        }

        var document = new JsonObject
        {
            ["openapi"] = "3.1.0",
            ["info"] = new JsonObject
            {
                ["title"] = "FsusBlog Binary API",
                ["version"] = "2.0.0",
                ["description"] = "Generated HTTP shell contract for /api/binary AEDS v2 endpoints from compiled endpoint metadata."
            },
            ["paths"] = paths,
            ["components"] = new JsonObject
            {
                ["schemas"] = new JsonObject
                {
                    ["AedsFrame"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["format"] = "binary"
                    }
                }
            },
            ["x-fsus-contract-source"] = new JsonObject
            {
                ["observation"] = "compiled-endpoint-metadata",
                ["protocol"] = "src/shared/Contracts/Validation/aeds-protocol.json",
                ["endpointContracts"] = "src/shared/Contracts/Validation/aeds-endpoint-contracts.json"
            },
            ["x-fsus-observation-digest"] = observation.ObservationDigest
        };
        document["x-fsus-protocol-states"] = JsonSerializer.SerializeToNode(observation.ProtocolStates);
        document["x-fsus-error-authority"] = JsonSerializer.SerializeToNode(observation.ErrorAuthority);

        return document.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
            IndentCharacter = ' ',
            IndentSize = 4
        }) + "\n";
    }

    private static JsonObject BinaryContent()
        => new()
        {
            ["application/octet-stream"] = new JsonObject
            {
                ["schema"] = new JsonObject
                {
                    ["type"] = "string",
                    ["format"] = "binary"
                }
            }
        };
}
