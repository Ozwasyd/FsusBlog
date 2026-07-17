export function integrityProofCommand(env = process.env) {
  void env
  return [
    'test',
    'tests/backend/FsusBlog.Server.Tests.csproj',
    '--configuration',
    'Debug',
    '--no-build',
    '--no-restore',
    '--filter',
    'FullyQualifiedName~IntegrityProofVerification'
  ]
}
