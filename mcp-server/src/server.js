// MCP server wiring: eight v0.1 tools over the registry/arcgis/databricks/
// inspect/publish modules. buildServer() is a factory so HTTP mode can create
// per-request instances (stateless streamable HTTP) and tests can inject deps.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArcGisClient } from "./arcgis.js";
import { TargetRegistry } from "./registry.js";
import { getAuth, execSql } from "./databricks.js";
import { inspectTable, buildPublishViewSql, validateTableName } from "./inspect.js";
import { buildServiceJson, getProviderManifest, waitForStart, smokeTest, assertOwnService, PROVIDER_NAME } from "./publish.js";
import { repackageCdpk, loadCdpk, registerProviderFlow, unregisterProviderFlow } from "./provider.js";

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

  function sqlRunner(target, overrides = {}) {
    const profile = overrides.profile || target.databricks?.profile;
    const warehouseId = overrides.warehouseId || target.databricks?.warehouseId || process.env.DATABRICKS_WAREHOUSE_ID;
    if (!warehouseId) {
      throw new Error(
        `No SQL warehouse configured for target '${target.name}' — set databricks.warehouseId on the target or pass warehouseId.`
      );
    }
    const auth = _getAuth({ profile });
    return { runSql: (stmt) => _execSql(auth, warehouseId, stmt), profile: profile || "DEFAULT", warehouseId };
  }

  const server = new McpServer({ name: "databricks-cdf-mcp", version: "0.1.0" });

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
          const { runSql, profile, warehouseId } = sqlRunner(target);
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
        "Install (or with update=true, replace) a Custom Data Feed provider on the target ArcGIS Server from a .cdpk package " +
        "on the MCP server host. Optionally rename the provider (providerName) and bake environment config into the package " +
        "(envVars) — baked env survives future updates, eliminating the classic '.cdpk update wiped my .env' failure. " +
        "Updating a live provider briefly restarts it; its services may blip. New provider code may require an ArcGIS Server " +
        "restart to fully load.",
      inputSchema: {
        cdpkPath: z.string().describe("Path to the .cdpk on the MCP server host"),
        target: TARGET_PARAM,
        providerName: z.string().optional().describe("Override the provider name inside the package (for side-by-side installs)"),
        envVars: z.record(z.string()).optional().describe("KEY=value pairs baked into the package as .env (e.g. DATABRICKS_SERVER_HOSTNAME)"),
        update: z.boolean().optional().describe("Replace an already-registered provider (required for upgrades)"),
        confirm: z.boolean().optional().describe("Required when update=true — the update replaces the live provider directory"),
      },
    },
    async ({ cdpkPath, target: targetParam, providerName, envVars, update, confirm }) => {
      try {
        if (update && !confirm) {
          throw new Error("update=true replaces the live provider directory (its services blip). Set confirm=true to proceed.");
        }
        const { client } = await resolveTargetAndClient(targetParam);
        const repack = repackageCdpk(loadCdpk(cdpkPath), { providerName, envVars });
        const manifest = await registerProviderFlow(client, repack.buffer, repack.providerName, {
          mode: update ? "update" : "register",
        });
        return text({
          [update ? "updated" : "registered"]: repack.providerName,
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
        const { runSql } = sqlRunner(target, { profile, warehouseId });
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
        const { runSql } = sqlRunner(target, { profile, warehouseId });
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

        // Derive parameters via inspection unless fully overridden.
        let inspection = null;
        let params = { tableName: fqn };
        const fullyOverridden = args.geometryColumn && args.geometryFormat && args.idField;
        if (fullyOverridden) {
          Object.assign(params, {
            geometryColumn: args.geometryColumn,
            geometryFormat: args.geometryFormat,
            idField: args.idField,
            srid: args.srid || "4326",
            timeColumn: args.timeColumn || "",
          });
        } else {
          const { runSql } = sqlRunner(target, args);
          inspection = await inspectTable(runSql, fqn);
          if (!inspection.readyToPublish) {
            return text({
              published: false,
              reason: "Table failed inspection — fix the issues below (create_publish_view can fix id problems) or pass explicit overrides.",
              inspection,
            });
          }
          params = { ...inspection.serviceParameters };
          for (const key of ["geometryColumn", "geometryFormat", "idField", "srid", "timeColumn"]) {
            if (args[key]) params[key] = args[key];
          }
        }
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
        await waitForStart(client, serviceName);
        const smoke = await smokeTest(client, serviceName);

        return text({
          published: true,
          serviceName,
          featureServerUrl: `${client.restUrl}/services/${serviceName}/FeatureServer`,
          layerUrl: `${client.restUrl}/services/${serviceName}/FeatureServer/0`,
          smokeTest: smoke,
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
