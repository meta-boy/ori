import type { Db } from "./db/client";
import type { MachineDriver } from "./drivers/types";
import type { TokenStore } from "./tokens";
import type { RouteRegistrar } from "./edge/registrar";
import { EDGE_DOMAIN } from "./constants";

export { EDGE_DOMAIN };

/** /api/ori/v1 is the public base. The control plane answers the whole envelope surface. */
export const BASE_PATH = "/api/ori/v1";

/** Request-scoped variables set by middleware. */
export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by the auth middleware for authenticated requests. */
    userId?: string;
    login?: string;
    email?: string | null;
    /**
     * Which credential authenticated this request.
     *
     * Routes that MINT credentials require "session". A bearer key must not be able to create
     * more bearer keys: a leaked key would then be self-perpetuating -- you revoke it, and the
     * attacker has already minted replacements. Minting is gated behind something a human
     * holds, which is the password-backed session.
     */
    authKind?: "session" | "key";
    /** Set by the machine-token middleware for /internal/oris/* requests. */
    machineOriId?: string;
  };
  Bindings: Record<string, never>;
};

/** Control-plane dependencies. `now` is injectable for deterministic tests. */
export interface AppDeps {
  db: Db;
  driver: MachineDriver;
  tokens: TokenStore;
  /** Edge route registrar (Caddy). Optional: without it, hosted URLs are tracked but not live. */
  routes?: RouteRegistrar;
  now?: () => Date;
}

export type AppContext = AppEnv;