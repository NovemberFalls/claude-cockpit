/**
 * Tests for TopBar's OpenRouter model gating (see task brief: OpenRouter
 * model levers).
 *
 * TopBar fetches GET /api/settings/openrouter on mount (and again whenever
 * the OpenRouterModal closes) to gate the OpenRouter group in the model
 * picker, and to disable the effort/fast controls when an OpenRouter model
 * is selected. Tests mock globalThis.fetch and await the resulting state
 * update via waitFor before asserting on rendered output — mirrors the
 * fetch-mocking conventions used by OpenRouterModal.test.jsx.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar, { MODELS } from "../components/TopBar.jsx";

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function renderTopBar({ model = "sonnet", onToast = vi.fn(), setModel = vi.fn() } = {}) {
  render(
    <ThemeProvider>
      <TopBar
        model={model}
        setModel={setModel}
        permissionMode="default"
        setPermissionMode={vi.fn()}
        effort=""
        setEffort={vi.fn()}
        fast={false}
        setFast={vi.fn()}
        sidebarOpen={false}
        setSidebarOpen={vi.fn()}
        user={{ name: "X" }}
        onToast={onToast}
      />
    </ThemeProvider>
  );
  return { onToast, setModel };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar — OpenRouter group gating (model picker)", () => {
  it("renders the OpenRouter group with a hint and disabled entries when the key is not configured", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    renderTopBar();

    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByText("Add a key via the key icon to enable")).toBeInTheDocument();
    });

    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    const entry = screen.getByRole("option", { name: "DeepSeek V4 Pro" });
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute("aria-disabled", "true");
  });

  it("clicking a disabled OpenRouter entry does not call setModel", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    const { setModel } = renderTopBar();

    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "DeepSeek V4 Pro" })).toBeDisabled();
    });

    fireEvent.click(screen.getByRole("option", { name: "DeepSeek V4 Pro" }));
    expect(setModel).not.toHaveBeenCalled();
  });

  it("makes OpenRouter entries selectable once the key is configured", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: true, source: "ui", masked: "sk-or-v1…338d" }));
    const { setModel } = renderTopBar();

    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.queryByText("Add a key via the key icon to enable")).not.toBeInTheDocument();
    });

    const entry = screen.getByRole("option", { name: "DeepSeek V4 Pro" });
    expect(entry).not.toBeDisabled();

    fireEvent.click(entry);
    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-pro");
  });
});

describe("TopBar — effort/fast controls disabled for an OpenRouter selection", () => {
  it("disables the effort picker and shows the OpenRouter tooltip", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: true, source: "ui", masked: null }));
    renderTopBar({ model: "deepseek/deepseek-v4-pro" });

    const effortBtn = screen.getByRole("button", { name: /effort:/i });
    expect(effortBtn).toBeDisabled();
    expect(effortBtn).toHaveAttribute("title", "Not available for OpenRouter models");
  });

  it("disables the fast toggle and shows the OpenRouter tooltip", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: true, source: "ui", masked: null }));
    renderTopBar({ model: "qwen/qwen3-coder-next" });

    const fastBtn = screen.getByRole("button", { name: /fast mode/i });
    expect(fastBtn).toBeDisabled();
    expect(fastBtn).toHaveAttribute("title", "Not available for OpenRouter models");
  });

  it("leaves effort/fast enabled for an Anthropic Opus selection (control)", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: true, source: "ui", masked: null }));
    renderTopBar({ model: "claude-opus-4-8" });

    expect(screen.getByRole("button", { name: /effort:/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /fast mode/i })).not.toBeDisabled();
  });
});

describe("TopBar — OpenRouter key-removed fallback", () => {
  it("reverts the selection to MODELS[0] and fires the toast callback when the key is (or becomes) unconfigured", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    const { setModel, onToast } = renderTopBar({ model: "deepseek/deepseek-v4-pro" });

    await waitFor(() => {
      expect(setModel).toHaveBeenCalledWith(MODELS[0].id);
    });
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining(MODELS[0].label),
      "info"
    );
  });

  it("does not touch the selection when an Anthropic model is already selected", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    const { setModel, onToast } = renderTopBar({ model: "sonnet" });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });
});
