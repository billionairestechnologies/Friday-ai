import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { useAuthStore } from "./lib/auth/client";
import { installCrashReporter } from "./lib/crash";
import "./styles.css";

installCrashReporter();
void useAuthStore.getState().bootstrap();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
