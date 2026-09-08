import React from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@interchained/portal-react";
import { routes } from "@portal/routes";
import contract from "../app.contract";
import "./index.css";

function NotFound(): React.ReactElement {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", textAlign: "center" }}>
      <div>
        <p style={{ fontFamily: "monospace", color: "#22d3ee" }}>404</p>
        <h1>Nothing on this marquee</h1>
        <a href="/" style={{ color: "#22d3ee" }}>
          Back to the studio
        </a>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(
  <React.StrictMode>
    <PortalProvider routes={routes} contract={contract} notFound={NotFound} />
  </React.StrictMode>,
);
