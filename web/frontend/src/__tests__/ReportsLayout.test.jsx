import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ReportsView from "../components/reports/ReportsView.jsx";
import DiagnosticsSettings from "../components/settings/DiagnosticsSettings.jsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const report = {
  sessions: Array.from({ length: 78 }, (_, i) => ({ session_id: `session-${i}`, model: "test", total_tokens: 1 })),
  by_model: [{ model: "test", cost: 1 }],
  by_day: [],
  kpis: {},
};

describe("reports and diagnostics use their available height", () => {
  it("gives a long session table a growing, bounded scroll body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => report })));
    render(<ReportsView initialTab="sessions" />);
    const table = await screen.findByTestId("sessions-table");
    expect(table).toHaveStyle({ display: "flex", flexDirection: "column", flex: "1" });
    const body = screen.getByTestId("sessions-scroll-body");
    expect(body).toHaveStyle({ flex: "1", minHeight: "0", overflow: "auto" });
    expect(body.style.maxHeight).toBe("");
    expect(body.querySelectorAll("tbody tr")).toHaveLength(78);
  });

  it("stretches both overview panels into the remaining space", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => report })));
    render(<ReportsView />);
    const panels = await screen.findByTestId("reports-overview-tables");
    expect(panels).toHaveStyle({ flex: "1 0 220px", alignItems: "stretch" });
    expect(panels.firstElementChild).toHaveStyle({ height: "100%" });
  });

  it("grows the diagnostics log while retaining a minimum usable reading area", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<DiagnosticsSettings />);
    expect(screen.getByTestId("card-logs")).toHaveStyle({ flex: "1", display: "flex", flexDirection: "column" });
    const body = screen.getByTestId("logs-body");
    expect(body).toHaveStyle({ flex: "1 0 220px", minHeight: "220px", overflow: "auto" });
    expect(body.style.height).toBe("");
  });
});
