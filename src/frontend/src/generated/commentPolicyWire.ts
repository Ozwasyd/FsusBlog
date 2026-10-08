// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
export const COMMENT_POLICY_WIRE = Object.freeze({
  "podBytes": 41,
  "minMaxChars": 100,
  "hardMaxChars": 3000,
  "minMaxUtf8Bytes": 1024,
  "hardMaxUtf8Bytes": 12288,
  "authorModes": [
    3,
    4
  ],
  "fields": [
    {
      "name": "anonymousCommentsEnabled",
      "offset": 0,
      "type": "byte"
    },
    {
      "name": "publicCommentsEnabled",
      "offset": 1,
      "type": "byte"
    },
    {
      "name": "zkAnonymousEnabled",
      "offset": 2,
      "type": "byte"
    },
    {
      "name": "defaultAuthorMode",
      "offset": 3,
      "type": "byte"
    },
    {
      "name": "zkProdEnabled",
      "offset": 4,
      "type": "byte"
    },
    {
      "name": "zkProdNativeVerifierConfigured",
      "offset": 5,
      "type": "byte"
    },
    {
      "name": "zkProdTrustedSetupVerified",
      "offset": 6,
      "type": "byte"
    },
    {
      "name": "zkProdCredentialRequired",
      "offset": 7,
      "type": "byte"
    },
    {
      "name": "zkProdCredentialRootReady",
      "offset": 8,
      "type": "byte"
    },
    {
      "name": "commentMaxChars",
      "offset": 9,
      "type": "int32"
    },
    {
      "name": "commentMaxUtf8Bytes",
      "offset": 13,
      "type": "int32"
    },
    {
      "name": "supportedDisplayLanguages",
      "offset": 17,
      "type": "slice"
    },
    {
      "name": "snapshotHash",
      "offset": 25,
      "type": "slice"
    },
    {
      "name": "zkProdUnavailableReason",
      "offset": 33,
      "type": "slice"
    }
  ],
  "booleanMaxByte": 1,
  "publicAuthorMode": 3,
  "zkAnonymousAuthorMode": 4
} as const);
export const COMMENT_POLICY_OFFSETS = Object.freeze({
  "anonymousCommentsEnabled": 0,
  "publicCommentsEnabled": 1,
  "zkAnonymousEnabled": 2,
  "defaultAuthorMode": 3,
  "zkProdEnabled": 4,
  "zkProdNativeVerifierConfigured": 5,
  "zkProdTrustedSetupVerified": 6,
  "zkProdCredentialRequired": 7,
  "zkProdCredentialRootReady": 8,
  "commentMaxChars": 9,
  "commentMaxUtf8Bytes": 13,
  "supportedDisplayLanguages": 17,
  "snapshotHash": 25,
  "zkProdUnavailableReason": 33
} as const);
export const commentPolicyWireFields = ["anonymousCommentsEnabled","publicCommentsEnabled","zkAnonymousEnabled","defaultAuthorMode","zkProdEnabled","zkProdNativeVerifierConfigured","zkProdTrustedSetupVerified","zkProdCredentialRequired","zkProdCredentialRootReady","commentMaxChars","commentMaxUtf8Bytes","supportedDisplayLanguages","snapshotHash","zkProdUnavailableReason"] as const;
