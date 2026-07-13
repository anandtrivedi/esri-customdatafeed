// MCP server wiring: eight v0.1 tools over the registry/arcgis/databricks/
// inspect/publish modules. buildServer() is a factory so HTTP mode can create
// per-request instances (stateless streamable HTTP) and tests can inject deps.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json");
import { ArcGisClient } from "./arcgis.js";
import { TargetRegistry, saveLocalTarget } from "./registry.js";
import { getAuth, execSql } from "./databricks.js";
import { inspectTable, buildPublishViewSql, validateTableName } from "./inspect.js";
import { buildServiceJson, getProviderManifest, waitForStart, smokeTest, assertOwnService, PROVIDER_NAME } from "./publish.js";
import { repackageCdpk, loadCdpk, registerProviderFlow, unregisterProviderFlow, buildProviderPackage } from "./provider.js";

const TARGET_PARAM = z
  .string()
  .optional()
  .describe("Registered GIS target name or its server URL/hostname. Optional when exactly one target is registered.");

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function toolError(e) {
  return { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true };
}

export function buildServer({ registry, deps = {} } = {}) {
  const reg = registry || new TargetRegistry();
  const _getAuth = deps.getAuth || getAuth;
  const _execSql = deps.execSql || execSql;
  const _clientFor = deps.clientFor || ((target) => new ArcGisClient(target));

  async function resolveTargetAndClient(targetParam) {
    const target = await reg.resolve(targetParam);
    return { target, client: _clientFor(target) };
  }

  async function sqlRunner(target, overrides = {}) {
    const profile = overrides.profile || target.databricks?.profile;
    const warehouseId = overrides.warehouseId || target.databricks?.warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;
    if (!warehouseId) {
      throw new Error(
        `No SQL warehouse configured for target '${target.name}' — set databricks.warehouseId on the target or pass warehouseId.`
      );
    }
    const auth = await _getAuth({ profile });
    return { runSql: (stmt) => _execSql(auth, warehouseId, stmt), profile: profile || "DEFAULT", warehouseId };
  }

  const server = new McpServer({ name: "databricks-cdf-mcp", version: pkg.version });

  server.registerTool(
    "list_gis_targets",
    {
      title: "List registered GIS targets",
      description:
        "List ArcGIS Server targets registered with this MCP server (credentials are stored server-side and never shown). " +
        "Targets are registered out-of-band by an operator — never through chat.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await reg.listTargets());
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "register_gis_target",
    {
      title: "Register an ArcGIS Server target (conversational onboarding)",
      description:
        "Register a new ArcGIS Server as a named target so its tables can be published. Collects everything EXCEPT the " +
        "admin password (which must never pass through chat) and saves it to the local registry, then returns the single " +
        "terminal command the user runs once to set the password securely. This is the normal first-run onboarding step: " +
        "gather adminUrl/user/databricks details in conversation, call this, then have the user run the printed command " +
        "before test_connectivity. For shared/hosted deployments, prefer a secret-scope-backed registry instead (see docs).",
      inputSchema: {
        name: z.string().describe("Short name for this target (e.g. 'demo-gis')"),
        adminUrl: z.string().describe("ArcGIS admin API URL, ending in /arcgis/admin (e.g. https://gis.example.com:6443/arcgis/admin)"),
        user: z.string().describe("ArcGIS admin username (e.g. siteadmin)"),
        databricksProfile: z.string().optional().describe("Databricks CLI profile for SQL/inspection (defaults to DEFAULT)"),
        warehouseId: z.string().optional().describe("SQL warehouse ID used for table inspection"),
        allowSelfSigned: z.boolean().optional().describe("Set true if the ArcGIS Server uses a self-signed certificate"),
      },
    },
    async ({ name, adminUrl, user, databricksProfile, warehouseId, allowSelfSigned }) => {
      try {
        if (!/\/arcgis\/admin\/?$/.test(adminUrl)) {
          throw new Error(`adminUrl must end in /arcgis/admin — got '${adminUrl}'`);
        }
        const target = {
          adminUrl: adminUrl.replace(/\/+$/, ""),
          user,
          passwordPending: true,
          allowSelfSigned: Boolean(allowSelfSigned),
          databricks: {
            ...(databricksProfile ? { profile: databricksProfile } : {}),
            ...(warehouseId ? { warehouseId } : {}),
          },
        };
        const file = saveLocalTarget(name, target);
        return text({
          registered: name,
          savedTo: file,
          passwordPending: true,
          nextStep: `Run this once in a terminal on this machine to set the admin password securely (it prompts — the password never goes through chat):\n\n  cdf-mcp set-password ${name}\n\nThen say "test connectivity to ${name}".`,
          note: databricksProfile || warehouseId ? undefined : "No Databricks profile/warehouse set — inspection/publish will need one; you can pass it per-call or re-register.",
        });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "test_connectivity",
    {
      title: "Test GIS + Databricks connectivity",
      description:
        "Verify the ArcGIS Server admin API is reachable (mints a short-lived token) and the Databricks SQL warehouse answers a probe query.",
      inputSchema: { target: TARGET_PARAM },
    },
    async ({ target: targetParam }) => {
      try {
        const { target, client } = await resolveTargetAndClient(targetParam);
        const result = { target: target.name, adminUrl: target.adminUrl };
        await client.getToken();
        result.arcgis = "OK — admin token minted";
        try {
          const { runSql, profile, warehouseId } = await sqlRunner(target);
          await runSql("SELECT 1");
          result.databricks = `OK — warehouse ${warehouseId} responded (profile ${profile})`;
        } catch (e) {
          result.databricks = `FAILED — ${e.message}`;
        }
        return text(result);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "provider_status",
    {
      title: "Custom Data Feed provider status",
      description: `Check that the ${PROVIDER_NAME} .cdpk is registered on the target ArcGIS Server, its version, and whether editing is enabled.`,
      inputSchema: { target: TARGET_PARAM },
    },
    async ({ target: targetParam }) => {
      try {
        const { client } = await resolveTargetAndClient(targetParam);
        return text(await getProviderManifest(client));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "register_provider",
    {
      title: "Register or update the CDF provider from a .cdpk",
      description:
        "Install (or with update=true, replace) a Custom Data Feed provider on the target ArcGIS Server. Provide EITHER " +
        "cdpkPath (a prebuilt .cdpk on the MCP server host) OR sourcePath (a provider source directory — the package is " +
        "built from source: npm install --omit=dev + zip from an explicit include list, immune to the wildcard-exclude " +
        "packaging footgun). Optionally rename the provider (providerName) and bake environment config into the package " +
        "(envVars) — baked env survives future updates, eliminating the classic '.cdpk update wiped my .env' failure. " +
        "Updating a live provider briefly restarts it; its services may blip. New provider code may require an ArcGIS Server " +
        "restart to fully load.",
      inputSchema: {
        cdpkPath: z.string().optional().describe("Path to a prebuilt .cdpk on the MCP server host"),
        sourcePath: z.string().optional().describe("Path to the provider source dir (contains cdconfig.json) to build from"),
        skipInstall: z.boolean().optional().describe("With sourcePath: skip npm install and use the existing node_modules (airgapped hosts with vendored deps)"),
        target: TARGET_PARAM,
        providerName: z.string().optional().describe("Override the provider name inside the package (for side-by-side installs)"),
        envVars: z.record(z.string()).optional().describe("KEY=value pairs baked into the package as .env (e.g. DATABRICKS_SERVER_HOSTNAME)"),
        update: z.boolean().optional().describe("Replace an already-registered provider (required for upgrades)"),
        confirm: z.boolean().optional().describe("Required when update=true — the update replaces the live provider directory"),
      },
    },
    async ({ cdpkPath, sourcePath, skipInstall, target: targetParam, providerName, envVars, update, confirm }) => {
      try {
        if (update && !confirm) {
          throw new Error("update=true replaces the live provider directory (its services blip). Set confirm=true to proceed.");
        }
        if (!cdpkPath && !sourcePath) throw new Error("Provide cdpkPath (prebuilt package) or sourcePath (build from source).");
        if (cdpkPath && sourcePath) throw new Error("Provide only one of cdpkPath / sourcePath.");
        const { client } = await resolveTargetAndClient(targetParam);
        let base;
        let built = null;
        if (sourcePath) {
          built = buildProviderPackage(sourcePath, { runInstall: !skipInstall });
          base = built.buffer;
        } else {
          base = loadCdpk(cdpkPath);
        }
        const repack = repackageCdpk(base, { providerName, envVars });
        const manifest = await registerProviderFlow(client, repack.buffer, repack.providerName, {
          mode: update ? "update" : "register",
        });
        return text({
          [update ? "updated" : "registered"]: repack.providerName,
          builtFromSource: built ? { sourcePath, entryCount: built.entryCount, warnings: built.warnings.length ? built.warnings : undefined } : undefined,
          renamedFrom: repack.originalName !== repack.providerName ? repack.originalName : undefined,
          envBaked: envVars ? Object.keys(envVars) : undefined,
          manifest: { arcgisVersion: manifest.arcgisVersion, editingEnabled: manifest.editingEnabled, parameterCount: manifest.parameterKeys.length },
          note: "If services on this provider misbehave after a code update, restart ArcGIS Server to reload the provider runtime.",
        });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "unregister_provider",
    {
      title: "Unregister a CDF provider",
      description:
        "Remove a Custom Data Feed provider from the target ArcGIS Server. Refuses if any feature service still uses it " +
        "(unpublish them first), and requires confirm=true.",
      inputSchema: {
        providerName: z.string().describe("Exact provider name to unregister"),
        target: TARGET_PARAM,
        confirm: z.boolean().describe("Must be true — removes the provider from the server"),
      },
    },
    async ({ providerName, target: targetParam, confirm }) => {
      try {
        if (!confirm) throw new Error("Set confirm=true to unregister the provider.");
        const { client } = await resolveTargetAndClient(targetParam);
        const services = await client.listServices();
        const serviceProviders = [];
        const unverifiable = [];
        for (const svc of services.filter((s) => s.type === "FeatureServer")) {
          try {
            const json = await client.getService(svc.serviceName);
            serviceProviders.push({
              serviceName: svc.serviceName,
              dataProviderName: json.jsonProperties?.customDataProviderInfo?.dataProviderName,
            });
          } catch {
            unverifiable.push(svc.serviceName);
          }
        }
        if (unverifiable.length) {
          throw new Error(
            `Cannot verify the provider of ${unverifiable.length} service(s) (${unverifiable.slice(0, 5).join(", ")}) — ` +
              "refusing to unregister until every service can be checked. Retry when the server is stable."
          );
        }
        return text(await unregisterProviderFlow(client, providerName, serviceProviders));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "inspect_table",
    {
      title: "Inspect a UC table for publishability",
      description:
        "DESCRIBE + sample a Unity Catalog table to derive feature-service parameters automatically: geometry column and format " +
        "(WKT/WKB/GeoJSON/native), SRID, a validated int32-safe unique id field, time column, and row count. Reports blocking " +
        "problems with suggested fixes. Run before publish_layer, or let publish_layer run it implicitly.",
      inputSchema: {
        table: z.string().describe("3-part Unity Catalog name: catalog.schema.table"),
        target: TARGET_PARAM,
        profile: z.string().optional().describe("Databricks CLI profile override"),
        warehouseId: z.string().optional().describe("SQL warehouse ID override"),
      },
    },
    async ({ table, target: targetParam, profile, warehouseId }) => {
      try {
        const target = await reg.resolve(targetParam);
        const { runSql } = await sqlRunner(target, { profile, warehouseId });
        return text(await inspectTable(runSql, table));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "create_publish_view",
    {
      title: "Create a publish-safe view",
      description:
        "Create (or replace) a view over a source table that adds a ROW_NUMBER()-based int32 'objectid' column, for tables whose " +
        "id column is missing, non-unique, or exceeds the 32-bit OBJECTID limit. Publish the view instead of the table.",
      inputSchema: {
        sourceTable: z.string().describe("3-part source table name"),
        viewName: z.string().describe("3-part name for the view to create"),
        orderBy: z.string().optional().describe("Column that defines a stable row order (recommended)"),
        target: TARGET_PARAM,
        profile: z.string().optional(),
        warehouseId: z.string().optional(),
      },
    },
    async ({ sourceTable, viewName, orderBy, target: targetParam, profile, warehouseId }) => {
      try {
        const target = await reg.resolve(targetParam);
        const { runSql } = await sqlRunner(target, { profile, warehouseId });
        const sql = buildPublishViewSql(sourceTable, viewName, { orderBy });
        await runSql(sql);
        return text({ created: viewName, sql, note: "Publish this view with publish_layer. ROW_NUMBER ids are not stable across refreshes unless orderBy is a stable column." });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "publish_layer",
    {
      title: "Publish a UC table as an ArcGIS feature service",
      description:
        "End-to-end publish: inspect the table (unless overrides supply everything), build the Custom Data Feed service definition, " +
        "create the service on ArcGIS Server, wait for it to start, and smoke-test a live query. Returns the FeatureServer URL. " +
        "Use dryRun to preview the service definition without creating anything.",
      inputSchema: {
        table: z.string().describe("3-part Unity Catalog table/view name"),
        serviceName: z.string().optional().describe("Service name (default: derived from table name)"),
        description: z.string().optional(),
        target: TARGET_PARAM,
        geometryColumn: z.string().optional(),
        geometryFormat: z.enum(["WKT", "WKB", "GEOJSON", "GEOMETRY"]).optional(),
        idField: z.string().optional(),
        srid: z.string().optional(),
        timeColumn: z.string().optional(),
        maxRecordCount: z.string().optional(),
        workspace: z.string().optional().describe("Provider-side .databrickscfg profile on the ArcGIS box (multi-workspace routing)"),
        provider: z.string().optional().describe(`CDF provider to publish through (default ${PROVIDER_NAME})`),
        warehouseHttpPath: z.string().optional(),
        profile: z.string().optional().describe("Databricks profile for inspection queries"),
        warehouseId: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const { target, client } = await resolveTargetAndClient(args.target);
        const fqn = validateTableName(args.table);
        const serviceName = args.serviceName || fqn.split(".").pop().replace(/[^A-Za-z0-9_]/g, "_");

        const manifest = await getProviderManifest(client, args.provider || PROVIDER_NAME);

        // Derive parameters via inspection; user overrides feed INTO the
        // inspection (a partial override — e.g. just geometryColumn — is
        // enough when detection alone would fail).
        const { runSql } = await sqlRunner(target, args);
        const inspection = await inspectTable(runSql, fqn, {
          overrides: {
            geometryColumn: args.geometryColumn,
            geometryFormat: args.geometryFormat,
            srid: args.srid,
            idField: args.idField,
          },
        });
        if (!inspection.readyToPublish) {
          return text({
            published: false,
            reason: "Table failed inspection — fix the issues below (create_publish_view can fix id problems) or pass explicit overrides.",
            inspection,
          });
        }
        const params = { ...inspection.serviceParameters };
        if (args.timeColumn) params.timeColumn = args.timeColumn;
        if (args.maxRecordCount) params.maxRecordCount = args.maxRecordCount;
        if (args.workspace) params.workspace = args.workspace;
        if (args.warehouseHttpPath) params.warehouseHttpPath = args.warehouseHttpPath;

        const serviceJson = buildServiceJson({
          serviceName,
          description: args.description || `${fqn} via Databricks Custom Data Feed (published by databricks-cdf-mcp)`,
          params,
          manifestParams: manifest.parameterKeys,
          providerName: args.provider || PROVIDER_NAME,
        });

        if (args.dryRun) return text({ dryRun: true, serviceJson, inspection });

        const existing = (await client.listServices()).find(
          (s) => s.serviceName.toLowerCase() === serviceName.toLowerCase()
        );
        if (existing) throw new Error(`Service '${serviceName}' already exists — choose another serviceName or unpublish it first.`);

        await client.createService(serviceJson);
        // The service now EXISTS — verification failures below must not read
        // as "publish failed" or the agent will retry and hit "already exists".
        let smoke = null;
        let verifyError = null;
        try {
          await waitForStart(client, serviceName);
          smoke = await smokeTest(client, serviceName);
        } catch (e) {
          verifyError = e.message;
        }

        return text({
          published: true,
          verified: !verifyError,
          serviceName,
          featureServerUrl: `${client.restUrl}/services/${serviceName}/FeatureServer`,
          layerUrl: `${client.restUrl}/services/${serviceName}/FeatureServer/0`,
          smokeTest: smoke ?? undefined,
          verificationError: verifyError
            ? `Service was created but failed verification: ${verifyError}. Investigate (service params, provider runtime) or remove it with unpublish_layer — do NOT re-run publish_layer with the same name.`
            : undefined,
          rowCount: inspection?.rowCount ?? undefined,
          warnings: inspection?.warnings || [],
        });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "list_layers",
    {
      title: "List published CDF feature services",
      description: `List feature services on the target ArcGIS Server, marking which are backed by the ${PROVIDER_NAME} provider and which Databricks table each serves.`,
      inputSchema: { target: TARGET_PARAM },
    },
    async ({ target: targetParam }) => {
      try {
        const { client } = await resolveTargetAndClient(targetParam);
        const services = await client.listServices();
        const detailed = [];
        for (const svc of services.filter((s) => s.type === "FeatureServer")) {
          try {
            const json = await client.getService(svc.serviceName);
            const info = json.jsonProperties?.customDataProviderInfo;
            detailed.push({
              serviceName: svc.serviceName,
              url: `${client.restUrl}/services/${svc.serviceName}/FeatureServer`,
              cdfProvider: info?.dataProviderName || null,
              table: info?.serviceParameters?.tableName || info?.serviceParameters?.lakebaseTable || null,
              editable: Boolean(info?.serviceParameters?.lakebaseHost),
            });
          } catch {
            detailed.push({ serviceName: svc.serviceName, cdfProvider: null, note: "detail fetch failed" });
          }
        }
        return text(detailed);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.registerTool(
    "unpublish_layer",
    {
      title: "Delete a CDF feature service",
      description:
        `Delete a feature service from the target ArcGIS Server. Safety: refuses to touch services not backed by the ${PROVIDER_NAME} provider, and requires confirm=true.`,
      inputSchema: {
        serviceName: z.string().describe("Exact service name to delete"),
        target: TARGET_PARAM,
        provider: z.string().optional().describe(`Provider the service must belong to (default ${PROVIDER_NAME})`),
        confirm: z.boolean().describe("Must be true — this permanently deletes the service (the Databricks table is untouched)"),
      },
    },
    async ({ serviceName, target: targetParam, provider, confirm }) => {
      try {
        if (!confirm) throw new Error("Set confirm=true to delete. The underlying Databricks table is never affected.");
        const { client } = await resolveTargetAndClient(targetParam);
        const serviceJson = await client.getService(serviceName);
        assertOwnService(serviceJson, serviceName, provider || PROVIDER_NAME);
        await client.deleteService(serviceName);
        return text({ deleted: serviceName, note: "Feature service removed; Databricks data untouched." });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  return server;
}
