import { computed, onMounted, reactive, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import { useRouter } from 'vue-router';

import type { TaxonomyMetadataMutationRequest } from '@/api/binaryFrame';
import type { ApiRequestConfig } from '@/api/requestConfig';
import { useMutationFlow } from '@/composables/useMutationFlow';
import { usePow } from '@/composables/usePow';
import { useViewTask } from '@/composables/useViewTask';
import type { TaxonomyExactMetadata } from '@/contracts/binaryApi';
import type { FsusDialogWidth } from '@/fsusui/dialog';
import { isFsusUiOk } from '@/fsusui/result';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';

import type { FormItemRule, FormRules } from '@ozwasyd/element-plus';

export type TaxonomyNameDisplay = 'text' | 'tag';

export interface TaxonomyFormInstance {
    validate: () => Promise<unknown>;
}

export const taxonomyDescriptionMaxScalars = 500;

export function normalizeTaxonomyDescriptionInput(
    value: string
): { ok: true; description: string | null; } | { ok: false; }
{
    const trimmed = value.trim();
    if (trimmed.length === 0)
    {
        return { ok: true, description: null };
    }

    if (Array.from(trimmed).length > taxonomyDescriptionMaxScalars)
    {
        return { ok: false };
    }

    return { ok: true, description: trimmed };
}

export interface AdminTaxonomyItemBase {
    id: number;
    name: string;
    publicArticleCount: number;
    draftArticleCount: number;
    scheduledArticleCount: number;
    archivedArticleCount: number;
    totalBlockingArticleCount: number;
    canDelete: boolean;
}

export interface TaxonomyFormRules extends FormRules<'name' | 'description'> {
    name: {
        required?: boolean;
        min?: number;
        max?: number;
        pattern?: RegExp;
        message?: string;
        trigger: string;
        validator?: FormItemRule['validator'];
    }[];
    description?: {
        required?: boolean;
        min?: number;
        max?: number;
        pattern?: RegExp;
        message?: string;
        trigger: string;
        validator?: FormItemRule['validator'];
    }[];
}

export interface TaxonomySchema<TItem extends AdminTaxonomyItemBase = AdminTaxonomyItemBase> {
    kind: string;
    entityLabel: string;
    pageClass: string;
    pageTitle: string;
    pageDescription: string;
    summaryAriaLabel: string;
    summaryDescription: string;
    listTitle: string;
    toolbarLabel: string;
    searchPlaceholder: string;
    searchAriaLabel: string;
    nameColumnLabel: string;
    nameInputName: string;
    nameInputLabel: string;
    nameInputPlaceholder: string;
    descriptionInputName: string;
    descriptionInputLabel: string;
    descriptionInputPlaceholder: string;
    dialogWidth: FsusDialogWidth;
    dialogDescription: string;
    dialogNoteClass: string;
    dialogNoteGapClass: string;
    emptyTitle: string;
    filteredEmptyTitle: string;
    emptyDescription: string;
    filteredEmptyDescription: string;
    newButtonLabel: string;
    editLabel: string;
    compactEditLabel: string;
    compactEditIcon: boolean;
    compactDeleteIcon: boolean;
    fixActionColumn: boolean;
    nameDisplay: TaxonomyNameDisplay;
    nameColumnWidth: { compact: number; wide: number; };
    relationColumnWidth: { compact: number; wide: number; };
    actionColumnWidth: { compact: number; wide: number; };
    articleQueryKey: string;
    dialogTitle: (editing: boolean) => string;
    submitButtonText: string;
    rules: TaxonomyFormRules;
    loadItems: (config?: ApiRequestConfig) => Promise<TItem[]>;
    loadExactMetadata: (id: number, config?: ApiRequestConfig) => Promise<TaxonomyExactMetadata>;
    createItem: (request: TaxonomyMetadataMutationRequest, config?: ApiRequestConfig) => Promise<unknown>;
    updateItem: (id: number, request: TaxonomyMetadataMutationRequest, config?: ApiRequestConfig) => Promise<unknown>;
    deleteItem: (id: number, config?: ApiRequestConfig) => Promise<unknown>;
    loadFallbackMessage: string;
    loadFailureLog: string;
    loadExactMetadataFallbackMessage: string;
    loadExactMetadataFailureLog: string;
    duplicateWarning: (name: string) => string;
    createFallbackMessage: string;
    updateFallbackMessage: string;
    createSuccessMessage: string;
    updateSuccessMessage: string;
    postSaveWarningMessage: string;
    deleteBlockedWarning: (row: TItem) => string;
    deleteConfirmMessage: (row: TItem) => string;
    deleteConfirmTitle: string;
    deleteSuccessMessage: string;
    deleteFallbackMessage: string;
    postDeleteWarningMessage: string;
    relationLockReason: (row: TItem) => string;
}

export interface AdminTaxonomyManageState {
    list: ShallowRef<AdminTaxonomyItemBase[]>;
    filteredList: ComputedRef<AdminTaxonomyItemBase[]>;
    loading: Ref<boolean>;
    dialogVisible: Ref<boolean>;
    editingId: Ref<number | null>;
    dialogTitle: ComputedRef<string>;
    submitButtonText: ComputedRef<string>;
    isProcessing: ComputedRef<boolean>;
    isEditMetadataLoading: ComputedRef<boolean>;
    canSubmit: ComputedRef<boolean>;
    filters: { keyword: string; unusedOnly: boolean; };
    form: { name: string; description: string; };
    rules: Pick<TaxonomyFormRules, keyof TaxonomyFormRules>;
    relationLockReason: (row: AdminTaxonomyItemBase) => string;
    viewAssociatedArticles: (row: AdminTaxonomyItemBase) => void;
    hasDuplicateName: (name: string) => boolean;
    resetFilters: () => void;
    openDialog: (row?: AdminTaxonomyItemBase) => void;
    submitForm: (formInstance: TaxonomyFormInstance | null | undefined) => Promise<void>;
    handleDelete: (row: AdminTaxonomyItemBase) => void;
}

export function useAdminTaxonomyManage<TItem extends AdminTaxonomyItemBase>(
    endpoint: string,
    schema: TaxonomySchema<TItem>
): AdminTaxonomyManageState
{
    const router = useRouter();
    const powProvider = usePow();
    const loadTask = useViewTask();
    const metadataTask = useViewTask();
    const mutation = useMutationFlow();

    const list = shallowRef<AdminTaxonomyItemBase[]>([]);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const submitting = ref(false);
    const editingId = ref<number | null>(null);
    const editMetadataStatus = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
    const filters = reactive({ keyword: '', unusedOnly: false });
    const form = reactive({ name: '', description: '' });
    const rules: TaxonomyFormRules = {
        ...schema.rules,
        description: [
            {
                validator: (_rule: unknown, value: unknown) =>
                {
                    const text = typeof value === 'string' ? value : '';
                    if (!normalizeTaxonomyDescriptionInput(text).ok)
                    {
                        throw new Error('描述不能超过 500 个字符');
                    }
                },
                trigger: 'blur'
            }
        ]
    };

    const isProcessing = computed(() => submitting.value || powProvider.isCalculating.value);
    const isEditMetadataLoading = computed(() => editMetadataStatus.value === 'loading');
    const canSubmit = computed(() =>
    {
        if (isProcessing.value)
        {
            return false;
        }

        return editingId.value === null || editMetadataStatus.value === 'ready';
    });
    const dialogTitle = computed(() => schema.dialogTitle(Boolean(editingId.value)));
    const submitButtonText = computed(() =>
    powProvider.isCalculating.value ? '安全计算中...' : schema.submitButtonText
    );
    const filteredList = computed(() =>
    {
        const keyword = filters.keyword.trim().toLowerCase();
        return list.value.filter((item) =>
        {
            if (filters.unusedOnly && !item.canDelete)
            {
                return false;
            }

            return !keyword || item.name.toLowerCase().includes(keyword) || String(item.id).includes(keyword);
        });
    });

    const loadData = async (): Promise<boolean> =>
    {
        loading.value = true;
        try
        {
            const data = await loadTask.run(async (signal) =>
            {
                const config: ApiRequestConfig = { signal };
                return await schema.loadItems(config);
            }, {
                fallbackMessage: schema.loadFallbackMessage,
                onError: (error) =>
                {
                    console.error(`[Admin Taxonomy:${endpoint}] ${schema.loadFailureLog}`, error);
                    list.value = [];
                }
            });

            if (data)
            {
                list.value = Array.isArray(data) ? data : [];
            }

            return data !== undefined;
        }
        finally
        {
            loading.value = false;
        }
    };

    const loadEditMetadata = async (id: number): Promise<void> =>
    {
        editMetadataStatus.value = 'loading';
        const data = await metadataTask.run(async (signal) =>
        {
            const config: ApiRequestConfig = { signal };
            return await schema.loadExactMetadata(id, config);
        }, {
            fallbackMessage: schema.loadExactMetadataFallbackMessage,
            onError: (error) =>
            {
                console.error(`[Admin Taxonomy:${endpoint}] ${schema.loadExactMetadataFailureLog}`, error);
                showErrorToast(error, schema.loadExactMetadataFallbackMessage);
            }
        });

        if (editingId.value !== id || !dialogVisible.value)
        {
            return;
        }

        if (data)
        {
            form.description = data.description ?? '';
            editMetadataStatus.value = 'ready';
            return;
        }

        if (metadataTask.hasError.value)
        {
            editMetadataStatus.value = 'failed';
        }
    };

    const openDialog = (row?: AdminTaxonomyItemBase): void =>
    {
        editingId.value = row?.id ?? null;
        form.name = row?.name ?? '';
        form.description = '';
        dialogVisible.value = true;
        if (row)
        {
            void loadEditMetadata(row.id);
            return;
        }

        metadataTask.cancel();
        editMetadataStatus.value = 'ready';
    };

    const hasDuplicateName = (name: string): boolean =>
    {
        const normalized = name.trim().toLowerCase();
        return list.value.some((item) => item.id !== editingId.value && item.name.trim().toLowerCase() === normalized);
    };

    const submitForm = async (formInstance: TaxonomyFormInstance | null | undefined): Promise<void> =>
    {
        if (!formInstance || isProcessing.value || !canSubmit.value)
        {
            return;
        }

        try
        {
            const validation = await formInstance.validate();
            if (!isFsusUiOk(validation))
            {
                return;
            }

            const cleanName = form.name.trim();
            if (!cleanName)
            {
                return;
            }

            const normalizedDescription = normalizeTaxonomyDescriptionInput(form.description);
            if (!normalizedDescription.ok)
            {
                return;
            }

            if (hasDuplicateName(cleanName))
            {
                showWarningToast(schema.duplicateWarning(cleanName));
                return;
            }

            const request: TaxonomyMetadataMutationRequest = {
                name: cleanName,
                description: normalizedDescription.description
            };

            submitting.value = true;
            await mutation.run(async (signal) =>
            {
                const config: ApiRequestConfig = { signal };
                if (editingId.value)
                {
                    await schema.updateItem(editingId.value, request, config);
                }
                else
                {
                    await schema.createItem(request, config);
                }
            }, {
                fallbackMessage: editingId.value ? schema.updateFallbackMessage : schema.createFallbackMessage,
                successMessage: editingId.value ? schema.updateSuccessMessage : schema.createSuccessMessage,
                postSuccessWarningMessage: schema.postSaveWarningMessage,
                onSuccess: async () =>
                {
                    dialogVisible.value = false;
                    return await loadData();
                }
            });
        }
        catch (error: unknown)
        {
            console.error(`[Admin Taxonomy:${endpoint}] Submit failed:`, error);
        }
        finally
        {
            submitting.value = false;
        }
    };

    const runDelete = async (row: AdminTaxonomyItemBase): Promise<void> =>
    {
        if (isProcessing.value)
        {
            return;
        }

        submitting.value = true;
        try
        {
            await mutation.confirmThenRun({
                message: schema.deleteConfirmMessage(row as TItem),
                title: schema.deleteConfirmTitle,
                confirmButtonText: '确认删除'
            }, async (signal) =>
            {
                const config: ApiRequestConfig = { signal };
                await schema.deleteItem(row.id, config);
            }, {
                fallbackMessage: schema.deleteFallbackMessage,
                successMessage: schema.deleteSuccessMessage,
                postSuccessWarningMessage: schema.postDeleteWarningMessage,
                onSuccess: loadData
            });
        }
        finally
        {
            submitting.value = false;
        }
    };

    const handleDelete = (row: AdminTaxonomyItemBase): void =>
    {
        if (!row.canDelete)
        {
            showWarningToast(schema.deleteBlockedWarning(row as TItem));
            return;
        }

        void runDelete(row).catch((error: unknown) =>
        {
            console.error(`[Admin Taxonomy:${endpoint}] Delete failed:`, error);
        });
    };

    const relationLockReason = (row: AdminTaxonomyItemBase): string =>
        schema.relationLockReason(row as TItem);

    const viewAssociatedArticles = (row: AdminTaxonomyItemBase): void =>
    {
        void router.push({
            name: 'ManageArticleList',
            query: {
                page: '1',
                size: '10',
                [schema.articleQueryKey]: String(row.id)
            }
        });
    };

    const resetFilters = (): void =>
    {
        filters.keyword = '';
        filters.unusedOnly = false;
    };

    onMounted(() =>
    {
        void loadData();
        powProvider.prewarm();
    });

    return {
        list,
        filteredList,
        loading,
        dialogVisible,
        editingId,
        dialogTitle,
        submitButtonText,
        isProcessing,
        isEditMetadataLoading,
        canSubmit,
        filters,
        form,
        rules,
        relationLockReason,
        viewAssociatedArticles,
        hasDuplicateName,
        resetFilters,
        openDialog,
        submitForm,
        handleDelete
    };
}
