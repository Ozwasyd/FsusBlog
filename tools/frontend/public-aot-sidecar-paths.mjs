import { join } from 'node:path'

export function resolvePublicAotSidecarDirectories({ env = process.env, repoRoot }) {
  if (!repoRoot) throw new Error('public AOT sidecar resolution requires repoRoot')

  const backendWebRoot = env.FSUSBLOG_BACKEND_WEBROOT
    || join(repoRoot, 'src', 'backend', 'wwwroot')
  const frontendDistRoot = env.FSUSBLOG_FRONTEND_DIST_ROOT
    || join(repoRoot, 'src', 'frontend', 'dist')

  return {
    sourceDir: env.FSUSBLOG_PUBLIC_AOT_SIDECAR_SOURCE_DIR
      || join(backendWebRoot, 'aot-cache', 'payloads'),
    previewDistDir: env.FSUSBLOG_PUBLIC_AOT_SIDECAR_DIST_DIR
      || join(frontendDistRoot, 'aot-cache', 'payloads')
  }
}
