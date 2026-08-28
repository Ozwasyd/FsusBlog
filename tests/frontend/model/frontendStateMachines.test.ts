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

const messageMachine = {
  initial: 'conversation_selected',
  transitions: {
    conversation_selected: { editReply: 'reply_draft', closeConversation: 'closed_conversation' },
    reply_draft: { switchConversation: 'draft_decision', send: 'sending' },
    draft_decision: { saveDraft: 'conversation_selected', discardDraft: 'conversation_selected', cancelSwitch: 'reply_draft' },
    sending: { sent: 'conversation_selected', failSend: 'reply_draft' },
    closed_conversation: { switchConversation: 'conversation_selected' }
  }
} satisfies Machine<
  'conversation_selected' | 'reply_draft' | 'draft_decision' | 'sending' | 'closed_conversation',
  'editReply' | 'switchConversation' | 'closeConversation' | 'saveDraft' | 'discardDraft' | 'cancelSwitch' | 'send' | 'sent' | 'failSend'
>

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
  it('prevents message drafts from silently crossing conversations', () => {
    expect(walk(messageMachine, ['editReply', 'switchConversation', 'saveDraft'])).toBe('conversation_selected')
    expect(() => transition(messageMachine, 'closed_conversation', 'send')).toThrow('illegal transition')
  })

  it('keeps upload resume and abandon transitions explicit', () => {
    expect(walk(uploadMachine, ['selectFile', 'upload', 'failChunk', 'resume', 'upload', 'complete'])).toBe('completed')
    expect(() => transition(uploadMachine, 'paused', 'complete')).toThrow('illegal transition')
  })
})
