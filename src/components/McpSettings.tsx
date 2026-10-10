// MCP server settings: enable/port controls, masked token with explicit
// reveal, clipboard copy, rotation and live status. A token minted by enabling
// the server is shown once from that command result. Other reads happen only
// on reveal or copy, and the token is never logged.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { m } from "../i18n";

export default function McpSettings() {
  const desktop = api.isDesktop();
  const [status, setStatus] = useState<api.McpStatus | null>(null);
  const [port, setPort] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [rotated, setRotated] = useState(false);
  const [issued, setIssued] = useState(false);
  const [busy, setBusy] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const portDirty = useRef(false);

  const apply = (next: api.McpStatus) => {
    setStatus(next);
    // Status events must not clobber a port the user is still editing.
    if (!portDirty.current) setPort(String(next.port));
    setError(next.error ? String(next.error) : "");
    // A disable or a missing credential clears a token this page is showing.
    if (!next.enabled || !next.hasToken) {
      setToken(null);
      setIssued(false);
    }
  };

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let off: (() => void) | undefined;
    api
      .mcpStatus()
      .then((s) => {
        if (alive) apply(s);
      })
      .catch((e) => alive && setError(String(e)));
    void listen<api.McpStatus>("mcp-status-changed", (event) => {
      if (alive) apply(event.payload);
    }).then((fn) => {
      if (alive) off = fn;
      else fn();
    });
    return () => {
      alive = false;
      off?.();
      window.clearTimeout(copyTimer.current);
    };
  }, [desktop]);

  const markCopied = (which: string) => {
    setCopied(which);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(
      () => setCopied((c) => (c === which ? "" : c)),
      2000,
    );
  };

  const copy = async (which: "url" | "token" | "config") => {
    setError("");
    try {
      // Copying the URL never touches the keyring.
      const text =
        which === "url"
          ? url
          : await (async () => {
              const connection = await api.mcpConnection();
              return which === "token"
                ? connection.token
                : JSON.stringify(
                    {
                      mcpServers: {
                        lutriui: {
                          url: connection.url,
                          headers: {
                            Authorization: `Bearer ${connection.token}`,
                          },
                        },
                      },
                    },
                    null,
                    2,
                  );
            })();
      await navigator.clipboard.writeText(text);
      markCopied(which);
    } catch (e) {
      setError(String(e));
    }
  };

  const run = async (work: () => Promise<api.McpStatus>) => {
    setBusy(true);
    setError("");
    try {
      apply(await work());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const configure = (nextEnabled: boolean, nextPort: number) =>
    void run(async () => {
      const next = await api.mcpConfigure(nextEnabled, nextPort);
      if (next.issuedToken) {
        setToken(next.issuedToken);
        setRotated(false);
        setIssued(true);
      }
      return next;
    });

  if (!desktop)
    return (
      <section>
        <h3>{m.settings_mcp()}</h3>
        <p className="help">{m.mcp_desktop_required()}</p>
      </section>
    );

  const enabled = status?.enabled ?? false;
  const running = status?.running ?? false;
  const url = status?.url ?? `http://127.0.0.1:${port || "39631"}/mcp`;

  return (
    <section>
      <h3>{m.settings_mcp()}</h3>
      <p className="help">{m.mcp_help()}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !status}
          onChange={(e) =>
            configure(e.target.checked, Number(port) || status?.port || 39631)
          }
        />
        {m.mcp_enabled()}
      </label>
      <label>
        {m.mcp_port()}
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          disabled={busy || !status}
          onChange={(e) => {
            portDirty.current = true;
            setPort(e.target.value);
          }}
        />
      </label>
      <div className="row">
        <button
          disabled={
            busy ||
            !status ||
            Number(port) === status.port ||
            !Number.isInteger(Number(port)) ||
            Number(port) < 1024 ||
            Number(port) > 65535
          }
          onClick={() => configure(enabled, Number(port))}
        >
          {m.mcp_apply()}
        </button>
      </div>
      <p className="help" role="status">
        {running ? m.mcp_state_running() : m.mcp_state_stopped()}
        {" · "}
        {status?.uiReady ? m.mcp_workspace_ready() : m.mcp_workspace_waiting()}
      </p>
      {enabled && (
        <>
          <label>
            URL
            <span className="row">
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
              <button disabled={busy} onClick={() => void copy("url")}>
                {copied === "url" ? m.mcp_copied() : m.mcp_copy()}
              </button>
            </span>
          </label>
          <label>
            {m.mcp_token()}
            <span className="row">
              <input
                readOnly
                type={token ? "text" : "password"}
                value={token ?? m.mcp_token_hidden()}
              />
              <button
                disabled={busy}
                onClick={() => {
                  if (token) setToken(null);
                  else
                    void (async () => {
                      setBusy(true);
                      setError("");
                      try {
                        setToken((await api.mcpConnection()).token);
                        setRotated(false);
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setBusy(false);
                      }
                    })();
                }}
              >
                {token ? m.mcp_hide() : m.mcp_reveal()}
              </button>
              <button disabled={busy} onClick={() => void copy("token")}>
                {copied === "token" ? m.mcp_copied() : m.mcp_copy()}
              </button>
            </span>
          </label>
          <div className="row">
            <button disabled={busy} onClick={() => void copy("config")}>
              {copied === "config" ? m.mcp_copied() : m.mcp_copy_config()}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await api.mcpRotateToken();
                  setToken(null);
                  setIssued(false);
                  setRotated(true);
                  return next;
                })
              }
            >
              {m.mcp_rotate()}
            </button>
          </div>
          {issued && !rotated && (
            <p className="help" role="status">
              {m.mcp_token_issued()}
            </p>
          )}
          {rotated && !busy && (
            <p className="help" role="status">
              {m.mcp_rotated()}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
