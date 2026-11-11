// Fase 0 aceite: RpcClient abre sessão no NoishiCLI e responde um prompt.
// Throwaway probe — roda contra o checkout do NoishiCLI.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RpcClient } = require(`${process.env.NOISHI_CLI_ROOT}/packages/coding-agent/dist/index.js`);

const cwd = "/tmp/noishi-desktop-probe";

const client = new RpcClient({
	cliPath: `${process.env.NOISHI_CLI_ROOT}/packages/coding-agent/dist/cli.js`,
	cwd,
	provider: "ghostcli",
	model: "claude-opus-5-5",
});

const events = [];
client.onEvent((e) => events.push(e.type));

await client.start();
console.log("[probe] started");

const state = await client.getState();
console.log("[probe] state:", JSON.stringify({ sessionId: state.sessionId, model: state.model?.id, streaming: state.isStreaming }));

const disposition = await client.prompt("Responda exatamente: PONG");
console.log("[probe] prompt disposition:", JSON.stringify(disposition));

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
	const s = await client.getState();
	if (!s.isStreaming) break;
	await new Promise((r) => setTimeout(r, 500));
}

const last = await client.getLastAssistantText();
console.log("[probe] last assistant text:", JSON.stringify(last));

const stats = await client.getSessionStats();
console.log("[probe] stats:", JSON.stringify(stats).slice(0, 200));

console.log("[probe] event kinds seen:", [...new Set(events)].join(","));

await client.stop();
console.log("[probe] stopped cleanly");

if (!String(last).includes("PONG")) {
	console.error("[probe] FAIL: expected PONG in response");
	process.exit(1);
}
console.log("[probe] PASS");
