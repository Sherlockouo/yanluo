import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./global.css";

const root = document.getElementById("app");
if (!root) throw new Error("Root element #app not found");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
