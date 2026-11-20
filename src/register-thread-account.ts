import type { PluginAppSlots } from "@get-bb/plugin-sdk/app";
import { STATUS_PAGE_PATH } from "./components/status-panel";
import { useThreadAccounts, type Display } from "./components/thread-account-status";

/**
 * Show the thread's CC-Router account as a button in the thread header; it
 * opens the CC-Router page.
 */
export function registerThreadAccount(slots: Pick<PluginAppSlots, "experimental_threadAction">): void {
  slots.experimental_threadAction<ReadonlyMap<string, Display>>({
    id: "cc-router-thread-account",
    title: "CC-Router account",
    icon: "ChartColumn",
    group: "cc-router",
    placement: "header",
    useData: ({ threadIds }) => useThreadAccounts(threadIds),
    item: ({ thread, data, navigate }) => {
      const display = data.get(thread.id);
      if (!display) return null;
      return {
        label: display.label,
        detail: display.detail.replaceAll("\n", " · "),
        icon: "ChartColumn",
        run: () => navigate.toPluginPanel(STATUS_PAGE_PATH),
      };
    },
  });
}
