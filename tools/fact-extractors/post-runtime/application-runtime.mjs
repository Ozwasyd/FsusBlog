/**
 * Application runtime adapter entrypoint. #2206 only registers the producer;
 * raw current-candidate sealing is implemented by the post-runtime adapter API.
 */
// BEHAVIOR-OWNER: application-runtime-semantic-coherence
export function extract()
{
  return {
    status: 'failed',
    failureReasons: ['post-runtime producer requires explicit current-run raw receipts'],
    observations: {}
  }
}

