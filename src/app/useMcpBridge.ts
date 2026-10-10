// Thin lifecycle binding between the Rust MCP bridge and the stable action
// object. Requests are queued BEFORE claiming: the claim happens just before
// dispatch so queued-but-unclaimed work can still be dropped cheaply. Every
// admitted request gets exactly one reply, including thrown failures.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import { errorPayload, McpError } from "./workspaceActions";
import type { ActionContext, ActionResult } from "./applicationActions";

export interface McpBridgeActions {
  dispatch(
    operation: string,
    args: unknown,
    context?: ActionContext,
  ): Promise<ActionResult>;
}

/**
 * `ready` must only become true once workspace and generation restoration
 * finished; unready/unmount unregisters the matching instance.
 */
export function useMcpBridge(actions: McpBridgeActions, ready: boolean) {
  useEffect(() => {
    if (!api.isDesktop() || !ready) return;
    const instanceId = crypto.randomUUID();
    let disposed = false;
    let off: (() => void) | undefined;
    let queue = Promise.resolve();
    const handle = (event: { payload: api.McpRequestEvent }) => {
      const req = event.payload;
      if (req.instanceId !== instanceId) return; // stale registration epoch
      // The queue serializes work; a rejection must not stall later requests.
      queue = queue
        .then(async () => {
          const assertActive = () => {
            if (
              disposed ||
              req.instanceId !== instanceId ||
              Date.now() > req.deadlineMs
            )
              throw new McpError(
                "REQUEST_EXPIRED",
                "the request expired before it could be applied",
              );
          };
          try {
            assertActive();
          } catch {
            return; // expired unclaimed work never executes and never claims
          }
          // Claim only the work that is actually starting now.
          let claimed = false;
          try {
            claimed = await api.mcpBridgeClaim(req.requestId, instanceId);
          } catch {
            claimed = false;
          }
          if (!claimed || disposed) return;
          try {
            const result = await actions.dispatch(req.operation, req.args, {
              assertActive,
            });
            await api
              .mcpBridgeReply(req.requestId, instanceId, result, undefined)
              .catch(() => {});
          } catch (e) {
            const err = errorPayload(e);
            await api
              .mcpBridgeReply(req.requestId, instanceId, undefined, {
                code: err.code,
                message: err.message,
                details: err.details,
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    // The listener must be live before registration advertises readiness.
    void listen<api.McpRequestEvent>("mcp-request", handle)
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        off = fn;
        return api.mcpBridgeRegister(instanceId);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
      void api.mcpBridgeUnregister(instanceId).catch(() => {});
    };
  }, [actions, ready]);
}
