import { describe, expect, it } from 'vitest'

type Machine<TState extends string, TEvent extends string> = Readonly<{
  initial: TState
  transitions: Readonly<Record<TState, Partial<Record<TEvent, TState>>>>
}>

function transition<TState extends string, TEvent extends string>(
  machine: Machine<TState, TEvent>,
  state: TState,
  event: TEvent
): TState {
  const next = machine.transitions[state][event]
  if (!next) {
    throw new Error(`illegal transition:${state}:${event}`)
  }
  return next
}

function walk<TState extends string, TEvent extends string>(
  machine: Machine<TState, TEvent>,
  events: readonly TEvent[]
): TState {
  return events.reduce((state, event) => transition(machine, state, event), machine.initial)
}

const uploadMachine = {
  initial: 'idle',
  transitions: {
    idle: { selectFile: 'compressing' },
    compressing: { upload: 'uploading', failCompress: 'abandoned' },
    uploading: { failChunk: 'paused', complete: 'completed', abandon: 'abandoned' },
    paused: { resume: 'resumed', abandon: 'abandoned' },
    resumed: { upload: 'uploading', failChunk: 'paused' },
    completed: { selectFile: 'compressing' },
    abandoned: { selectFile: 'compressing' }
  }
} satisfies Machine<
  'idle' | 'compressing' | 'uploading' | 'paused' | 'resumed' | 'completed' | 'abandoned',
  'selectFile' | 'upload' | 'failCompress' | 'failChunk' | 'complete' | 'abandon' | 'resume'
>

describe('frontend state machine models', () => {
  it('keeps upload resume and abandon transitions explicit', () => {
    expect(walk(uploadMachine, ['selectFile', 'upload', 'failChunk', 'resume', 'upload', 'complete'])).toBe('completed')
    expect(() => transition(uploadMachine, 'paused', 'complete')).toThrow('illegal transition')
  })
})
