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
