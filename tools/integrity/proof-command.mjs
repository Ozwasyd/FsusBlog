export function integrityProofCommand(env = process.env) {
  const command = [
    'test',
    'tests/backend/FsusBlog.Server.Tests.csproj',
    '--filter',
    'FullyQualifiedName~IntegrityProofVerification'
  ]
  if (env.FSUSBLOG_LOCAL_PROFILE) command.push('--configuration', 'Release', '--no-build', '--no-restore')
  return command
}
