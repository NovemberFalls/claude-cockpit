/**
 * Tests for OpenRouterModal (web/frontend/src/components/OpenRouterModal.jsx).
 *
 * Covers:
 *   - Status rendering from mocked GET: not-configured, ui-key, env-key
 *   - Save & Test: successful POST shows masked + credits, fires onToast
 *   - Save & Test: server 400 shows the inline error and fires onToast
 *   - Client-side rejection of empty/whitespace key issues no fetch
 *   - Remove flow: DELETE then env-fallback state shown
 *   - The input never displays a fetched/masked key value
 *
 * Mirrors the fetch-mocking conventions used by BridgeModal.test.jsx and
 * TerminalPane.actions.test.jsx (sequential globalThis.fetch mocks).
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import OpenRouterModal from "../components/OpenRouterModal.jsx";

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

function defaultProps(overrides = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onToast: vi.fn(),
    ...overrides,
  };
}

describe("OpenRouterModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1
  it("renders_not_configured_state_from_get", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: false, source: null, masked: null })
    );

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );
    // Remove key button must not be present when there is no ui-sourced key.
    expect(screen.queryByRole("button", { name: /remove key/i })).not.toBeInTheDocument();
  });

  // 2
  it("renders_ui_key_state_from_get", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: true, source: "ui", masked: "sk-or-v1…338d" })
    );

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(
        /connected.*sk-or-v1…338d/i
      )
    );
    expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
  });

  // 3
  it("renders_env_key_state_from_get", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: true, source: "env", masked: "sk-or-v1…9999" })
    );

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(
        /using environment key.*sk-or-v1…9999/i
      )
    );
    // Remove key only applies to a UI-sourced key.
    expect(screen.queryByRole("button", { name: /remove key/i })).not.toBeInTheDocument();
  });

  // 4
  it("save_and_test_success_shows_masked_and_credits_and_toasts", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockReturnValueOnce(jsonResponse({ configured: false, source: null, masked: null }))
      .mockReturnValueOnce(
        jsonResponse({ ok: true, masked: "sk-or-v1…338d", credits_remaining: 49.83 })
      );

    render(<OpenRouterModal {...defaultProps({ onToast })} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );

    const input = screen.getByLabelText(/api key/i);
    fireEvent.change(input, { target: { value: "sk-or-v1-realkeyvalue" } });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(
        /connected.*sk-or-v1…338d/i
      )
    );
    expect(screen.getByText(/\$49\.83 remaining/)).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("sk-or-v1…338d"), "success");

    // The full key the user typed must never leak back into the input.
    expect(input.value).toBe("");
  });

  // 5
  it("save_and_test_400_shows_server_error_inline_and_toasts", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockReturnValueOnce(jsonResponse({ configured: false, source: null, masked: null }))
      .mockReturnValueOnce(
        jsonResponse({ ok: false, error: "OpenRouter rejected the key" }, false)
      );

    render(<OpenRouterModal {...defaultProps({ onToast })} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );

    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-or-v1-badkey" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }));

    await waitFor(() =>
      expect(screen.getByText(/openrouter rejected the key/i)).toBeInTheDocument()
    );
    expect(onToast).toHaveBeenCalledWith("OpenRouter rejected the key", "error");
  });

  // 6
  it("client_side_rejects_empty_or_whitespace_key_without_fetching", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: false, source: null, masked: null })
    );

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText(/api key/i);
    const saveBtn = screen.getByRole("button", { name: /save & test/i });

    // Whitespace-only key
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(saveBtn);
    expect(screen.getByText(/cannot be empty or contain whitespace/i)).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Key containing embedded whitespace
    fireEvent.change(input, { target: { value: "sk-or v1-oops" } });
    fireEvent.click(saveBtn);
    expect(screen.getByText(/cannot be empty or contain whitespace/i)).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // 7
  it("remove_flow_deletes_then_shows_env_fallback_state", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockReturnValueOnce(
        jsonResponse({ configured: true, source: "ui", masked: "sk-or-v1…338d" })
      )
      .mockReturnValueOnce(jsonResponse({ ok: true, configured: true, source: "env" }));

    render(<OpenRouterModal {...defaultProps({ onToast })} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/connected/i)
    );

    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(
        /using environment key/i
      )
    );
    expect(onToast).toHaveBeenCalledWith("OpenRouter key removed", "info");
    // Remove key button disappears once the key is env-sourced, not ui.
    expect(screen.queryByRole("button", { name: /remove key/i })).not.toBeInTheDocument();
  });

  // 8
  it("remove_flow_falls_back_to_not_configured_when_no_env_key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockReturnValueOnce(
        jsonResponse({ configured: true, source: "ui", masked: "sk-or-v1…338d" })
      )
      .mockReturnValueOnce(jsonResponse({ ok: true, configured: false, source: null }));

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/connected/i)
    );

    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );
  });

  // 9
  it("input_never_displays_the_fetched_masked_key", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: true, source: "ui", masked: "sk-or-v1…338d" })
    );

    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(
        /sk-or-v1…338d/
      )
    );

    const input = screen.getByLabelText(/api key/i);
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
    expect(screen.queryByDisplayValue("sk-or-v1…338d")).not.toBeInTheDocument();
  });

  // 10
  it("renders_nothing_when_open_false", () => {
    globalThis.fetch = vi.fn();
    const { container } = render(<OpenRouterModal {...defaultProps({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // 11
  it("escape_closes_modal", async () => {
    const onClose = vi.fn();
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: false, source: null, masked: null })
    );
    render(<OpenRouterModal {...defaultProps({ onClose })} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 12
  it("show_hide_toggle_switches_input_type", async () => {
    globalThis.fetch = vi.fn().mockReturnValueOnce(
      jsonResponse({ configured: false, source: null, masked: null })
    );
    render(<OpenRouterModal {...defaultProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("openrouter-status")).toHaveTextContent(/not configured/i)
    );

    const input = screen.getByLabelText(/api key/i);
    expect(input.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show key/i }));
    expect(input.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /hide key/i }));
    expect(input.type).toBe("password");
  });
});
