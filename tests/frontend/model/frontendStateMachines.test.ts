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

const authMachine = {
  initial: 'guest',
  transitions: {
    guest: { submitPassword: 'password_submitted' },
    password_submitted: { rejectPassword: 'guest', requireMfa: 'mfa_required', authenticate: 'authenticated' },
    mfa_required: { rejectMfa: 'mfa_required', useRecoveryCode: 'recovery_code_used', authenticate: 'authenticated' },
    recovery_code_used: { authenticate: 'authenticated' },
    authenticated: { logout: 'guest' }
  }
} satisfies Machine<
  'guest' | 'password_submitted' | 'mfa_required' | 'recovery_code_used' | 'authenticated',
  'submitPassword' | 'rejectPassword' | 'requireMfa' | 'rejectMfa' | 'useRecoveryCode' | 'authenticate' | 'logout'
>

const markdownMachine = {
  initial: 'clean_draft',
  transitions: {
    clean_draft: { edit: 'editing' },
    editing: { saveDraft: 'autosaved', serverFail: 'server_draft_failed', publishShortcut: 'publish_confirm' },
    autosaved: { edit: 'editing', publishShortcut: 'publish_confirm' },
    server_draft_failed: { recover: 'recovered', edit: 'editing' },
    recovered: { saveDraft: 'autosaved', edit: 'editing' },
    publish_confirm: { cancelPublish: 'editing', confirmPublish: 'published' },
    published: { edit: 'editing' }
  }
} satisfies Machine<
  'clean_draft' | 'editing' | 'autosaved' | 'server_draft_failed' | 'recovered' | 'publish_confirm' | 'published',
  'edit' | 'saveDraft' | 'serverFail' | 'recover' | 'publishShortcut' | 'cancelPublish' | 'confirmPublish'
>

const settingsMachine = {
  initial: 'loaded',
  transitions: {
    loaded: { edit: 'dirty' },
    dirty: { save: 'clean', switchSlug: 'switch_slug_with_dirty' },
    clean: { edit: 'dirty', switchSlug: 'loaded' },
    switch_slug_with_dirty: { confirmSave: 'clean', discard: 'loaded', cancel: 'dirty' }
  }
} satisfies Machine<
  'loaded' | 'dirty' | 'clean' | 'switch_slug_with_dirty',
  'edit' | 'save' | 'switchSlug' | 'confirmSave' | 'discard' | 'cancel'
>

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
  it('guards MFA and recovery-code auth paths', () => {
    expect(walk(authMachine, ['submitPassword', 'requireMfa', 'useRecoveryCode', 'authenticate'])).toBe('authenticated')
    expect(() => transition(authMachine, 'guest', 'authenticate')).toThrow('illegal transition')
    expect(() => transition(authMachine, 'mfa_required', 'logout')).toThrow('illegal transition')
  })

  it('separates draft save from publish confirmation in markdown authoring', () => {
    expect(walk(markdownMachine, ['edit', 'saveDraft', 'publishShortcut', 'confirmPublish'])).toBe('published')
    expect(() => transition(markdownMachine, 'editing', 'confirmPublish')).toThrow('illegal transition')
  })

  it('requires a decision before switching dirty settings state', () => {
    expect(walk(settingsMachine, ['edit', 'switchSlug', 'cancel'])).toBe('dirty')
    expect(walk(settingsMachine, ['edit', 'switchSlug', 'discard'])).toBe('loaded')
    expect(() => transition(settingsMachine, 'dirty', 'discard')).toThrow('illegal transition')
  })

  it('prevents message drafts from silently crossing conversations', () => {
    expect(walk(messageMachine, ['editReply', 'switchConversation', 'saveDraft'])).toBe('conversation_selected')
    expect(() => transition(messageMachine, 'closed_conversation', 'send')).toThrow('illegal transition')
  })

  it('keeps upload resume and abandon transitions explicit', () => {
    expect(walk(uploadMachine, ['selectFile', 'upload', 'failChunk', 'resume', 'upload', 'complete'])).toBe('completed')
    expect(() => transition(uploadMachine, 'paused', 'complete')).toThrow('illegal transition')
  })
})
