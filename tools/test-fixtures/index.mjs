/** Public exports for the unique FixtureOrchestrator (#1709). */
export {
  plan,
  prepare,
  verify,
  cleanup,
  buildProducerDag,
  createTerminalState,
  FIXTURE_TERMINAL_STATES,
  normalizeProducerPort,
  createProducerContext
} from './orchestrator.mjs'
export {
  createDefaultProducerPorts,
  createPortsForProducerIds
} from './producers/catalog-ports.mjs'
