import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import "./globals.css";
import { App } from "./App";
import { registerWorker } from "./lib/push";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// The service worker, which caches nothing and exists only so a push can be
// received with no tab open. Registered here rather than on the first start
// because it asks the user nothing — the permission, which does, is asked for
// from the gesture that starts a session.
void registerWorker();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
