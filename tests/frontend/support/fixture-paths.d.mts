export type FixturePathOptions = {
  env?: NodeJS.ProcessEnv
  repoRoot?: string
}

export function resolveFixtureNamespace(env?: NodeJS.ProcessEnv): string
export function resolveFixtureRoot(options?: FixturePathOptions): string
export function resolvePublicFixtureFile(options?: FixturePathOptions): string
export function resolveFixtureAssetDirectory(options?: FixturePathOptions): string
export function resolveAuthFixtureDirectory(options?: FixturePathOptions): string
export function resolveAuthFixtureManifest(options?: FixturePathOptions): string
export function resolveSessionFixtureDirectory(options?: FixturePathOptions): string
export function resolveSessionFixtureFile(session: string, options?: FixturePathOptions): string
