import vectors from '../../fixtures/security/perception-character-v3-vectors.json'

type MediaVector = { artifactBase64: string }
const fixture = vectors as unknown as { visual: MediaVector; audio: MediaVector }

export function canonicalPerceptionCharacterV3Png(): Uint8Array {
  return decodeBase64(fixture.visual.artifactBase64)
}

export function canonicalPerceptionCharacterV3OpusOgg(): Uint8Array {
  return decodeBase64(fixture.audio.artifactBase64)
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}
