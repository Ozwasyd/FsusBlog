// Generated from src/shared/Contracts/Validation/public-representation-coordinate.json; do not edit by hand.
#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace FsusBlog::PublicRepresentation
{
inline constexpr std::uint8_t kCoordinateVersion = 1U;
inline constexpr std::string_view kSchema = "fsusblog.public-representation-coordinate.v1";
inline constexpr std::array<std::string_view, 14> kCoordinateFields = {
    "routeIdentity",
    "sourceVersion",
    "articleRevision",
    "publication",
    "visibilityVersion",
    "rendererVersion",
    "frontendRelease",
    "frontendAssetVersion",
    "aedsProtocolVersion",
    "aedsSchemaIdentity",
    "documentDigest",
    "hydrationSidecarDigest",
    "seoIdentity",
    "hydrationPageKind",
};
inline constexpr std::array<std::string_view, 7> kTransitions = {
    "canonical-to-public-aot",
    "public-aot-to-html",
    "hydration-to-sidecar",
    "canonical-to-hot-read",
    "materialize-runtime-entry",
    "artifact-to-browser-hydration",
    "service-worker-navigation",
};
} // namespace FsusBlog::PublicRepresentation
