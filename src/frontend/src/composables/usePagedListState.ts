import { computed, ref } from 'vue';

type PagedListStateOptions = {
  initialPage?: number;
  pageSize?: number;
};

export function usePagedListState(options: PagedListStateOptions = {}) {
  const currentPage = ref(options.initialPage ?? 1);
  const pageSize = ref(options.pageSize ?? 10);
  const total = ref(0);

  const loading = ref(false);
  const error = ref<string | null>(null);

  const hasMore = ref(true);
  const nextCursor = ref<string | null>(null);

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
  const isEmpty = computed(() => total.value === 0);

  const beginLoading = () => {
    loading.value = true;
    error.value = null;
  };

  const endLoading = () => {
    loading.value = false;
  };

  const setError = (message: string) => {
    error.value = message;
    loading.value = false;
  };

  const setPageTotal = (value: number) => {
    total.value = Number.isFinite(value) ? Math.max(0, value) : 0;
  };

  const resetCursorState = () => {
    hasMore.value = true;
    nextCursor.value = null;
  };

  return {
    currentPage,
    pageSize,
    total,
    totalPages,
    loading,
    error,
    isEmpty,
    hasMore,
    nextCursor,
    beginLoading,
    endLoading,
    setError,
    setPageTotal,
    resetCursorState
  };
}
