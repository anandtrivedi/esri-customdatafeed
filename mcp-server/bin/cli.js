#!/usr/bin/env node
// cdf-mcp CLI: serve (stdio | http) + operator-side target registration.
//
//   cdf-mcp serve [--transport stdio|http] [--port 8090]
//   cdf-mcp register-target <name> --admin-url <url> --user <user>
//           [--password-ref env:VAR | secret:scope/key] [--allow-self-signed]
//           [--databricks-profile P] [--warehouse-id W] [--validate-only]
//   cdf-mcp list-targets

import { createServer } from "node:http";
import readline from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../src/server.js";
import { TargetRegistry, saveLocalTarget, localTargetsPath } from "../src/registry.js";
import { ArcGisClient } from "../src/arcgis.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.stdoutMuted = true;
    process.stderr.write(question);
    rl._writeToOutput = () => {}; // mute echo
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function serveStdio() {
  const server = buildServer({});
  await server.connect(new StdioServerTransport());
  console.error("databricks-cdf-mcp: stdio transport ready");
}

async function serveHttp(port) {
  const bearer = process.env.CDF_MCP_BEARER_TOKEN;
  if (!bearer) {
    console.error("FATAL: HTTP mode requires CDF_MCP_BEARER_TOKEN to be set (transport auth).");
    process.exit(1);
  }
  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${bearer}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      // Stateless mode: fresh server+transport per request.
      const server = buildServer({});
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      console.error("request failed:", e);
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(e.message) }));
    }
  });
  httpServer.listen(port, "0.0.0.0", () => {
    console.error(`databricks-cdf-mcp: streamable HTTP on :${port}/mcp (bearer auth enforced)`);
  });
}

async function registerTarget(args) {
  const name = args._[1];
  if (!name || !args["admin-url"] || !args.user) {
    console.error("Usage: cdf-mcp register-target <name> --admin-url <url> --user <user> [--password-ref env:VAR|secret:scope/key]");
    process.exit(1);
  }
  const target = {
    adminUrl: args["admin-url"],
    user: args.user,
    allowSelfSigned: Boolean(args["allow-self-signed"]),
    databricks: {
      ...(args["databricks-profile"] ? { profile: args["databricks-profile"] } : {}),
      ...(args["warehouse-id"] ? { warehouseId: args["warehouse-id"] } : {}),
    },
  };
  let password;
  if (args["password-ref"]) {
    target.passwordRef = args["password-ref"];
  } else {
    password = await promptHidden(`ArcGIS admin password for ${args.user}@${name}: `);
    target.password = password;
  }

  // Validate before saving: mint a real token.
  const registry = new TargetRegistry();
  const resolved = { ...target, name, password: password || (await registry._resolvePassword(target, name)) };
  process.stderr.write("Validating credentials against the admin API... ");
  const client = new ArcGisClient(resolved);
  await client.getToken();
  const services = await client.listServices();
  process.stderr.write(`OK (${services.length} services visible)\n`);

  if (args["validate-only"]) {
    console.log("Validation succeeded; nothing saved (--validate-only).");
    return;
  }
  const file = saveLocalTarget(name, target);
  console.log(`Target '${name}' saved to ${file} (mode 0600).`);
  if (target.password) {
    console.log("Note: password stored inline in the local file. For shared/hosted deployments prefer --password-ref secret:scope/key.");
  }
}

async function listTargets() {
  const registry = new TargetRegistry();
  const targets = await registry.listTargets();
  if (Object.keys(targets).length === 0) {
    console.log(`No targets registered. Local file: ${localTargetsPath()}; secret scope: ${process.env.CDF_MCP_SECRET_SCOPE || "(unset)"}`);
    return;
  }
  console.log(JSON.stringify(targets, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "serve";

try {
  if (command === "serve") {
    const transport = args.transport || "stdio";
    if (transport === "http") await serveHttp(Number(args.port || 8090));
    else await serveStdio();
  } else if (command === "register-target") {
    await registerTarget(args);
  } else if (command === "list-targets") {
    await listTargets();
  } else {
    console.error(`Unknown command '${command}'. Commands: serve, register-target, list-targets`);
    process.exit(1);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
