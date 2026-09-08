/**
 * Tests for Settings ▸ Remote.
 *
 * Covers: devices render from GET /api/remote/status; the pair button is
 * disabled with a reason when remote is off; pairing renders a code and a
 * QR image; revoke uses the in-app confirm (never window.confirm), awaits
 * DELETE, and only removes the row on success, keeping it (with an inline
 * error) on failure.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import RemoteSettings from "../components/settings/RemoteSettings.jsx";

const STATUS_ON = {
  enabled: true,
  hostname: "https://studio.example.com",
  protocol: 1,
  devices: [
    {
      id: "dv_abc123",
      name: "Len's Pixel",
      created_at: "2026-09-01T10:00:00Z",
      last_seen: "2026-09-07T10:00:00Z",
      revoked_at: null,
    },
  ],
};

const STATUS_OFF = { enabled: false, hostname: "", protocol: 1, devices: [] };

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function makeFetchMock({ status = STATUS_ON, pairing, pairingOk = true, deleteOk = true, deleteBody = { revoked: true } } = {}) {
  return vi.fn((url, opts = {}) => {
    const method = opts.method || "GET";
    if (url === "/api/remote/status" && method === "GET") {
      return jsonResponse(status);
    }
    if (url === "/api/remote/pairings" && method === "POST") {
      return jsonResponse(
        pairing || {
          code: "ABCD-EFGH",
          expires_at: Date.now() / 1000 + 300,
          url: "https://studio.example.com",
          qr_payload: JSON.stringify({ v: 1, url: "https://studio.example.com", code: "ABCD-EFGH" }),
        },
        pairingOk
      );
    }
    if (url.startsWith("/api/remote/devices/") && method === "DELETE") {
      return jsonResponse(deleteOk ? deleteBody : { error: "revoke failed" }, deleteOk);
    }
    return jsonResponse({});
  });
}

function makeSettingsProps(overrides = {}) {
  const draft = { remote: { enabled: true, hostname: "https://studio.example.com" }, ...overrides };
  return {
    get: (path, fallback) => {
      const parts = path.split(".");
      let cur = draft;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object" || !(p in cur)) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    },
    setField: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RemoteSettings — devices", () => {
  it("renders devices from GET /api/remote/status", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("devices-table")).toBeInTheDocument());
    expect(screen.getByText("Len's Pixel")).toBeInTheDocument();
  });
});

describe("RemoteSettings — pairing gate", () => {
  it("disables the pairing button with a reason when remote is off", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_OFF });
    render(<RemoteSettings {...makeSettingsProps({ remote: { enabled: false, hostname: "" } })} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).toBeInTheDocument());
    expect(screen.getByTestId("start-pairing")).toBeDisabled();
    expect(screen.getByTestId("pairing-disabled-reason")).toBeInTheDocument();
  });
});

describe("RemoteSettings — pairing flow", () => {
  it("enabling then pairing shows the code and a QR image containing data", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("start-pairing"));

    await waitFor(() => expect(screen.getByTestId("pairing-code")).toHaveTextContent("ABCD-EFGH"));
    const qr = await screen.findByTestId("pairing-qr");
    expect(qr).toBeInTheDocument();
    expect(qr.getAttribute("src")).toMatch(/^data:image\//);
  });

  it("renders a 409 pairing error inline", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, pairing: { error: "remote disabled" }, pairingOk: false });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("start-pairing")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("start-pairing"));
    await waitFor(() => expect(screen.getByTestId("pairing-error")).toHaveTextContent("remote disabled"));
  });
});

describe("RemoteSettings — revoke", () => {
  it("opens an in-app confirm, awaits DELETE, and removes the row on success", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, deleteOk: true });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("revoke-dv_abc123"));
    expect(screen.getByTestId("revoke-confirm")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("revoke-confirm-button"));

    await waitFor(() => expect(screen.queryByTestId("revoke-confirm")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("device-row-dv_abc123")).not.toBeInTheDocument());
  });

  it("keeps the row and shows an inline error when DELETE fails", async () => {
    globalThis.fetch = makeFetchMock({ status: STATUS_ON, deleteOk: false });
    render(<RemoteSettings {...makeSettingsProps()} />);
    await waitFor(() => expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("revoke-dv_abc123"));
    fireEvent.click(screen.getByTestId("revoke-confirm-button"));

    await waitFor(() => expect(screen.getByTestId("revoke-error")).toHaveTextContent("revoke failed"));
    expect(screen.getByTestId("device-row-dv_abc123")).toBeInTheDocument();
  });
});
