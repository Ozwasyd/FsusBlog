export function transition(contract, state, command)
{
    if (!command.storeAvailable)
        return { ...state, publicError: 'unavailable' };
    if (state.status !== 'active')
        return { ...state, publicError: state.status === 'expired' || state.status === 'revoked' ? 'reissueRequired' : 'rejected' };
    if (command.type === 'revoke')
        return { ...state, status: 'revoked', publicError: 'reissueRequired' };
    if (command.nowUnixMs >= state.expiresAtUnixMs)
        return { ...state, status: 'expired', publicError: 'reissueRequired' };
    if (command.type !== 'verify')
        throw new Error('unknown state command');
    const attempts = state.attempts + 1;
    if (command.answerMatches)
        return { ...state, attempts, status: 'consumed', publicError: null };
    if (attempts >= contract.state.attemptBudget)
        return { ...state, attempts, status: 'exhausted', publicError: 'rejected' };
    return { ...state, attempts, publicError: 'retryable' };
}

export function switchRepresentation(contract, state, replacement)
{
    if (state.status !== 'active')
        throw new Error('only an active challenge can switch representation');
    if (!contract.representations.includes(replacement.representation)
        || replacement.representation === state.representation)
        throw new Error('replacement representation must be the other supported representation');
    if (!replacement.challengeId || !replacement.envelopeId
        || replacement.challengeId === state.challengeId
        || replacement.envelopeId === state.envelopeId
        || replacement.stateToken === state.stateToken)
        throw new Error('replacement must use fresh challenge, envelope, and token identities');
    return {
        revoked: { ...state, status: 'revoked' },
        issued: { ...replacement, attempts: 0, status: 'active' }
    };
}
