# Multi-Workspace Support

The CDF provider can serve Feature Services backed by **multiple Databricks workspaces** concurrently. Each Feature Service is registered with a `workspace` parameter that names a profile from `.databrickscfg`; the provider creates an independent connection pool per workspace and routes each request accordingly.

This applies to both backends:
- **Lakehouse** — reads via Databricks SQL Warehouse
- **Lakebase** — reads/writes via Databricks-managed PostgreSQL

> Note: each Feature Service hits exactly one workspace. Cross-workspace data federation (joining tables across workspaces in a single layer) is a Databricks-side concern (Unity Catalog federation, Delta Sharing) — solve it in the data layer and point the service at the resulting view.

## When you need this

- You have tables in two or more Databricks workspaces and want both surfaced as Feature Services.
- You want to expose a production workspace alongside a development workspace.
- You operate across security boundaries (e.g. classified vs. unclassified) where each workspace is a separate Databricks tenant.

If you only have one Databricks workspace, you don't need any of this — env vars (`DATABRICKS_SERVER_HOSTNAME`, `DATABRICKS_HTTP_PATH`, `DATABRICKS_ACCESS_TOKEN`) define an implicit default profile and existing services keep working unchanged.

## Configuration — `.databrickscfg` profiles

The provider reads `~/.databrickscfg` (or the path in the `DATABRICKS_CONFIG_FILE` env var). This is the same config format used by the Databricks CLI, Asset Bundles, and dbt — if you already have one, you can reuse it.

### Two supported auth modes per profile

**PAT (Personal Access Token):**
```ini
[WORKSPACE_A]
host  = workspace-a.cloud.databricks.com
token = dapiXXXXXXXXXXXXXXXXX
```

**OAuth M2M (Machine-to-Machine via Service Principal — recommended for new deployments):**
```ini
[WORKSPACE_B]
host          = workspace-b.cloud.databricks.com
client_id     = <service-principal-client-id>
client_secret = <service-principal-secret>
```

### Default profile resolution

When a service is created **without** a `workspace` parameter:
1. If a `[DEFAULT]` profile exists in `.databrickscfg`, it's used.
2. Otherwise, env vars (`DATABRICKS_SERVER_HOSTNAME` + `DATABRICKS_ACCESS_TOKEN`) are used as a synthesized default.
3. If neither is set, the service errors at request time.

This keeps single-workspace deployments zero-config — env vars alone work, no config file required.

## Service registration — adding `workspace` and `warehouseHttpPath` params

When creating a Feature Service via the ArcGIS Server Admin REST API, pass the new params alongside the existing ones:

```json
{
  "serviceName": "Cells_FromWorkspaceA",
  "type": "FeatureServer",
  "provider": "CUSTOMDATA",
  "jsonProperties": {
    "customDataProviderInfo": {
      "dataProviderName": "databricks-geospatial-provider",
      "forwardUserIdentity": "false",
      "serviceParameters": {
        "workspace": "WORKSPACE_A",
        "warehouseHttpPath": "/sql/1.0/warehouses/abc123",
        "tableName": "atrivedi.geospatial.cell_towers",
        "geometryColumn": "geometry",
        "idField": "tower_id",
        "srid": "4326"
      }
    }
  }
}
```

For a second service pointing at a different workspace, just change `workspace` and `warehouseHttpPath`:

```json
"serviceParameters": {
  "workspace": "WORKSPACE_B",
  "warehouseHttpPath": "/sql/1.0/warehouses/xyz789",
  "tableName": "atrivedi.geo.roads",
  ...
}
```

Both services live concurrently in the same ArcGIS Server. The provider holds two independent connection pools, one per workspace.

## Lakebase services across workspaces

Same `workspace` param applies. Use it alongside the existing Lakebase params:

```json
"serviceParameters": {
  "workspace": "WORKSPACE_A",
  "lakebaseHost": "instance-aaa.database.cloud.databricks.com",
  "lakebasePort": "5432",
  "lakebaseDatabase": "geospatial",
  "lakebaseSchema": "public",
  "lakebaseTable": "parcels",
  "geometryColumn": "geometry",
  "idField": "id"
}
```

The provider mints Lakebase OAuth tokens via the `workspace` profile's credentials — for OAuth M2M profiles, it first exchanges `client_id` / `client_secret` for a workspace API token at `/oidc/v1/token`, then uses that to call `/api/2.0/database/credentials`.

## Setting up Service Principals (OAuth M2M)

Per workspace, in the Databricks account console:

1. Create a service principal (or use an existing one).
2. Assign the SP to the workspace.
3. Generate an OAuth secret for the SP — save the `client_id` and `client_secret`.
4. Grant the SP `CAN_USE` on the SQL Warehouse it should access.
5. For Lakebase: grant the SP database-level access on the Lakebase instance and table.
6. Add the profile to `.databrickscfg` on the ArcGIS Server box.

See Databricks docs: [Authorize service principal access with OAuth M2M](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m).

## Where to put `.databrickscfg` on ArcGIS Server

ArcGIS Server runs as the `arcgis` OS user (typical install). The default location `~/.databrickscfg` resolves relative to that user's home directory, which may not exist or may be `/`.

**Recommended:** set `DATABRICKS_CONFIG_FILE` explicitly in the init script:

```bash
# /opt/arcgis/server/usr/init_user_param.sh
export DATABRICKS_CONFIG_FILE=/opt/arcgis/server/usr/.databrickscfg
```

Then create the file at that path and `chmod 600` it. Restart ArcGIS Server.

## Troubleshooting

**"Databricks workspace profile 'X' not found in /path/.databrickscfg"**
- Check the profile name spelling (case-sensitive).
- Verify the file exists at `DATABRICKS_CONFIG_FILE` (or `~/.databrickscfg`) for the OS user running ArcGIS Server.
- The error message lists available profiles — confirm yours is among them.

**"Profile [X] is ambiguous: defines both PAT (token) and OAuth M2M"**
- Pick one. Comment out either `token` OR `client_id`+`client_secret`.

**"OAuth M2M token endpoint returned 401"**
- Service principal client_id/client_secret is wrong or revoked.
- SP isn't assigned to that workspace.

**"No Lakebase instance found with hostname X in workspace Y"**
- The Lakebase host in `lakebaseHost` belongs to a different workspace than the one in the `workspace` profile. Confirm the two match (each Lakebase instance is registered to one workspace).

**Single-workspace deployment regressed after upgrade**
- Check that env vars `DATABRICKS_SERVER_HOSTNAME` and `DATABRICKS_ACCESS_TOKEN` are still set in the init script.
- Run a service that doesn't pass a `workspace` param — should fall back to env-var default.

## Verifying it works

After adding two services pointing at two workspaces, query each:

```bash
# Workspace A
curl -k 'https://your-arcgis-server:6443/arcgis/rest/services/Cells_FromWorkspaceA/FeatureServer/0/query?where=1=1&outFields=*&returnCountOnly=true&f=json'

# Workspace B
curl -k 'https://your-arcgis-server:6443/arcgis/rest/services/Roads_FromWorkspaceB/FeatureServer/0/query?where=1=1&outFields=*&returnCountOnly=true&f=json'
```

Both should return non-zero counts, with the responses pulling data from their respective Databricks workspaces. The provider logs (append `/logz` to the app URL) will show two distinct connection pools:

```
[Pool WORKSPACE_A|/sql/1.0/warehouses/abc123] Initialized (min: 2, max: 10)
[Pool WORKSPACE_B|/sql/1.0/warehouses/xyz789] Initialized (min: 2, max: 10)
```
