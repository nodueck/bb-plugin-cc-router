import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { STATUS_PAGE_PATH, StatusPanel } from "./src/components/status-panel";
import { useStatusBadge } from "./src/components/use-status-badge";
import { registerThreadAccount } from "./src/register-thread-account";
import "./app.css";

export default definePluginApp(app => {
  app.slots.navPanel({
    id: "cc-router-page",
    title: "CC-Router",
    icon: "ChartColumn",
    path: STATUS_PAGE_PATH,
    component: StatusPanel,
    experimental_useBadge: useStatusBadge,
  });
  registerThreadAccount(app.slots);
});
