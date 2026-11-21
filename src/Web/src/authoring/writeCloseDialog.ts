import { h, ref } from 'vue'
import { ElMessageBox, ElRadio, ElRadioGroup } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import { closeRiskMessageKey } from './writeCommandAdapter'
import type { ProtectedCloseChoice } from './writeWorkspaceController'
import type { ClosePlan, WorkspaceTab } from './workspaceRegistry'

export async function confirmProtectedCloseDialog(input: Readonly<{
  plan: ClosePlan
  hasKeepCopies: boolean
  canSave: boolean
  canDiscard: boolean
  current: () => boolean
}>): Promise<ProtectedCloseChoice> {
  const { plan, hasKeepCopies, canSave, canDiscard, current } = input
  const choice = ref<'keep' | 'discard' | 'save'>(hasKeepCopies ? 'keep' : 'save')
  const message = h(() => current() ? h('div', [
    h('ul', {
      'aria-label': t('author.write.tabsToClose'),
      tabindex: 0,
      style: {
        maxBlockSize: 'min(40vh, 16rem)',
        overflowY: 'auto',
        overflowWrap: 'anywhere',
        paddingInlineStart: '1.5rem',
      },
    }, plan.tabs.map(({ title, risk, articleId, sessionId }) => h('li', { key: sessionId },
      `${title} (${risk === 'clean' ? t('author.write.upToDate') : t(closeRiskMessageKey[risk])})${articleId ? t('author.write.articleSuffix', { id: articleId }) : ''}`))),
    h(ElRadioGroup, {
      modelValue: choice.value,
      label: t('author.write.unsavedEdits'),
      style: { display: 'grid', justifyItems: 'start' },
      'onUpdate:modelValue': (value: unknown) => {
        if (value === 'keep' || value === 'discard' || value === 'save') choice.value = value
      },
    }, {
      default: () => [
        hasKeepCopies ? h(ElRadio, { value: 'keep' }, () => t('author.write.keepBrowserRecoveryCopies')) : null,
        canSave ? h(ElRadio, { value: 'save' }, () => t('author.write.saveDraftsBeforeClosing')) : null,
        canDiscard ? h(ElRadio, { value: 'discard' }, () => t('author.write.discardUnsavedEditsFromThisBrowser')) : null,
      ],
    }),
  ]) : h('p', t('author.write.theWorkspaceChangedWhileThisConfirmationWasOpen')))

  try {
    const consent = await ElMessageBox.confirm(
      message,
      t('author.write.closeTabsWithUnsavedEdits'),
      {
        type: 'warning',
        confirmButtonText: t('author.write.closeTabs'),
        cancelButtonText: t('author.write.keepWriting'),
        closeOnClickModal: false,
      },
    )
    return consent.ok ? choice.value : 'cancelled'
  } catch {
    return 'cancelled'
  }
}

export async function confirmDiscardTabDialog(title: string): Promise<boolean> {
  try {
    const outcome = await ElMessageBox.confirm(
      t('author.write.discardTitle', { title }),
      t('author.write.closeArticleTab'),
      {
        type: 'warning',
        confirmButtonText: t('author.write.discardChanges'),
        cancelButtonText: t('author.write.keepWriting'),
        closeOnClickModal: false,
      },
    )
    return outcome.ok
  } catch {
    return false
  }
}

export async function confirmLeaveDialog(candidates: readonly WorkspaceTab[]): Promise<boolean> {
  try {
    const message = candidates.length === 1
      ? t('author.write.yourChangesWillBeLostIfYouLeave')
      : t('author.write.discardTitles', { titles: candidates.map(item => item.title).join(', ') })
    const outcome = await ElMessageBox.confirm(
      message,
      t('author.write.discardUnsavedChanges'),
      {
        type: 'warning',
        confirmButtonText: t('author.write.discardChanges'),
        cancelButtonText: t('author.write.keepWriting'),
        closeOnClickModal: false,
      },
    )
    return outcome.ok
  } catch {
    return false
  }
}
