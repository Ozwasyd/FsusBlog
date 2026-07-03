import { defineComponent, h, type PropType } from "vue";

export type FsusUiDataListRow = Record<string, unknown>;
export type FsusUiDataListRowKey = string | number;
export type FsusUiDataListColumn = {
  key: string;
  label: string;
  grid?: string;
  align?: "start" | "center" | "end";
};

const resolveRowKey = (
  row: FsusUiDataListRow,
  rowKey: string | ((row: FsusUiDataListRow) => FsusUiDataListRowKey),
): FsusUiDataListRowKey =>
  typeof rowKey === "function" ? rowKey(row) : String(row[rowKey] ?? "");

export const FsusUiDataList = defineComponent({
  name: "FsusUiDataList",
  props: {
    rows: {
      type: Array as PropType<FsusUiDataListRow[]>,
      default: () => [],
    },
    columns: {
      type: Array as PropType<FsusUiDataListColumn[]>,
      default: () => [],
    },
    rowKey: {
      type: [String, Function] as PropType<
        string | ((row: FsusUiDataListRow) => FsusUiDataListRowKey)
      >,
      required: true,
    },
    activeKey: {
      type: [String, Number] as PropType<FsusUiDataListRowKey | null>,
      default: null,
    },
    loadingKey: {
      type: [String, Number] as PropType<FsusUiDataListRowKey | null>,
      default: null,
    },
    href: {
      type: Function as PropType<(row: FsusUiDataListRow) => string>,
      default: null,
    },
    density: {
      type: String as PropType<"compact" | "default">,
      default: "default",
    },
    ariaLabel: {
      type: String,
      default: undefined,
    },
  },
  emits: {
    rowClick: (
      _row: FsusUiDataListRow,
      _key: FsusUiDataListRowKey,
      _event: MouseEvent,
    ) => true,
  },
  setup(props, { attrs, emit, slots }) {
    const isActive = (key: FsusUiDataListRowKey): boolean =>
      props.activeKey !== null && String(props.activeKey) === String(key);
    const isLoading = (key: FsusUiDataListRowKey): boolean =>
      props.loadingKey !== null && String(props.loadingKey) === String(key);

    return () => {
      if (props.rows.length === 0) {
        return h(
          "div",
          {
            ...attrs,
            class: ["fsus-ui-data-list", attrs.class],
            role: "list",
            "aria-label": props.ariaLabel,
          },
          slots.empty?.(),
        );
      }

      return h(
        "div",
        {
          ...attrs,
          class: [
            "fsus-ui-data-list",
            `fsus-ui-data-list--${props.density}`,
            attrs.class,
          ],
          role: "list",
          "aria-label": props.ariaLabel,
        },
        props.rows.map((row) => {
          const key = resolveRowKey(row, props.rowKey);
          const active = isActive(key);
          const loading = isLoading(key);
          const href = props.href?.(row);
          return h(
            href ? "a" : "button",
            {
              key,
              role: "listitem",
              href,
              type: href ? undefined : "button",
              class: [
                "fsus-ui-data-list__row",
                active && "is-active",
                loading && "is-loading",
              ],
              style: {
                display: "grid",
                gridTemplateColumns: props.columns
                  .map((column) => column.grid ?? "minmax(0, 1fr)")
                  .join(" "),
              },
              "aria-current": active ? "true" : undefined,
              "aria-busy": loading ? "true" : undefined,
              onClick: (event: MouseEvent) => emit("rowClick", row, key, event),
            },
            props.columns.map((column) =>
              h(
                "span",
                {
                  key: column.key,
                  class: [
                    "fsus-ui-data-list__cell",
                    column.align && `fsus-ui-data-list__cell--${column.align}`,
                  ],
                },
                slots.cell?.({ row, column, active, loading }) ??
                  String(row[column.key] ?? ""),
              ),
            ),
          );
        }),
      );
    };
  },
});
