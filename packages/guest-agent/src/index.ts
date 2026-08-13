import { serve } from "bun";
import { createGuestAgentApp } from "./app";

// Identity + credential injected at provision time via /etc/ori.env
// (EnvironmentFile in the systemd unit). The token is never logged.
const oriId = process.env.ORI_ID;
const agentToken = process.env.ORI_AGENT_TOKEN;

if (!oriId || !agentToken) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), fatal: true, msg: "ORI_ID and ORI_AGENT_TOKEN are required" }));
  process.exit(1);
}

const app = createGuestAgentApp({ oriId, agentToken });

const server = serve({
  hostname: "0.0.0.0",
  port: 7777,
  fetch: app.fetch,
});

console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "guest agent listening", oriId, port: 7777 }));

export { server };
