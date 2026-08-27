/**
 * Release/deployment runtime adapter entrypoint. #2206 only registers the
 * producer; no release candidate is executed by static fact extraction.
 */
// BEHAVIOR-OWNER: release-deployment-runtime-containment
export function extract()
{
  return {
    status: 'failed',
    failureReasons: ['post-runtime producer requires explicit current-run release receipts'],
    observations: {}
  }
}
