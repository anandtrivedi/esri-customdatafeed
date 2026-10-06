# internal/ — maintainer tooling (not part of the provider install)

These scripts are **internal dev/deploy helpers** used to manage the maintainer's own test
environment. They are **not** part of installing or using the CDF provider — if you're deploying
the provider, ignore this folder and follow the top-level [README](../README.md) (Steps 1–5) and
the customer-facing scripts at the repo root:

| Customer-facing (repo root) | Purpose |
|---|---|
| `register-provider.sh` | Build + register/update the provider on an ArcGIS Server |
| `publish-service.sh` | Publish a Databricks table as a Feature Service |
| `diagnose-service.sh` | Read-only health check for a published service |
| `build-release.sh` | (Maintainer) build a versioned, checksummed release `.cdpk` |

## What's in here

| Script | What it does | Notes |
|---|---|---|
| `deploy-dogfood.sh` | One-shot full deploy to a **specific** EC2 test box (`./deploy-dogfood.sh <IP>`) | Hardwired to the maintainer's SSH key + instance; reads `ADMIN_PASS` from env. Superseded for general use by `register-provider.sh` + `publish-service.sh`. |
| `setup-auto-schedule.sh` | Auto start/stop the test EC2 box (crontab shutdown + launchd start) | Cost-saver for the maintainer's box only. |
| `test-auth.sh` | Quick manual `curl` check of the auth feature against a service URL | Dev helper; edit `SERVICE_URL` first. |
| `start-local.sh` | Runs the old local `node server.js` dev server | Legacy local mode; not used by the CDF-in-ArcGIS deployment. |

These are kept in the repo for the maintainer's convenience and are **not supported** as customer
install tooling.

## Updating an already-registered provider (new `.cdpk` onto a live server)

Updating in place is **not** the same as a fresh register, and it has two gotchas worth knowing:

1. **Re-register — do not just patch files.** Editing `src/*.js` under
   `…/customdata/providers/databricks-geospatial-provider/` and restarting *looks* like it works,
   but ArcGIS re-extracts the **registered** `.cdpk` from the config-store on restart, so a bare
   file-patch is silently reverted by the next (often off-hours automatic) restart. For a durable
   update, upload the new `.cdpk` and call `POST …/admin/services/types/customdataproviders/update`
   (`id=<uploaded itemID>`), then restart the server so the runtime reloads it. Back up the provider
   directory to a path **outside** `providers/` first — a *failed* update can delete the provider
   dir and prune siblings.
2. **Token type depends on federation.**
   - **Standalone server:** a Server-admin token works — `…/admin/generateToken` with
     `client=requestip`. (`register-provider.sh` uses this path.)
   - **Federated server (fronted by Portal):** the site will not issue a Server-admin token to a
     non-local account, so `register-provider.sh` fails. Mint a **Portal** token instead
     (`<portal>/sharing/rest/generateToken` with `client=referer&referer=<portal>`) and send a
     matching `Referer` header on the admin calls.

   After the restart, a metadata request's first hit may 404 while the service SOC cold-starts —
   retry for ~30–60s before concluding anything is wrong.

Both update flows (standalone + federated) are small wrappers around the steps above; the
maintainer keeps the environment-specific copies with their box's hostnames/certs out of this repo.
