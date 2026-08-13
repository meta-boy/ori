/**
 * Wildcard edge domain for `host <port>` public URLs. The deployment sets EDGE_DOMAIN in
 * /etc/caddy/edge.env (infra/bootstrap.sh) and the Caddyfile serves `*.on.$EDGE_DOMAIN`, so
 * the control plane has to read the same value or every hosted URL it mints is for a domain
 * the edge does not answer for.
 */
export const EDGE_DOMAIN = process.env.EDGE_DOMAIN ? `on.${process.env.EDGE_DOMAIN}` : "on.ori.dev";

/** Base image ref handed to the MachineDriver. The image/ directory builds this. */
export const BASE_IMAGE = "ubuntu-24.04";

/** §4 single-tenant cap. */
export const MAX_ACTIVE_ORIS = 100;
