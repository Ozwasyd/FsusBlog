export function localFsusUiConsumptionDisabled(
  env?: Record<string, string | undefined>,
): boolean

export function resolveLocalFsusUiRepositoryRoot(options?: {
  override?: string | null
  repositoryRoot?: string
  gitCommonDirectory?: string
}): string | null
