import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error(
    'Root element not found. Add <div id="root"></div> in index.html.'
  );
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);