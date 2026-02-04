# Local Testing Guide

Complete guide to test your Databricks Custom Data Feed Provider locally before deployment.

## Prerequisites

- Node.js 18+ installed
- Databricks account with a SQL Warehouse
- A table with geospatial data

## Quick Start (5 minutes)

### Step 1: Install Dependencies

```bash
cd nodejs-provider
npm install

cd ../testing
npm install
```

### Step 2: Configure Environment

The `.env` file is already configured for Databricks Community Edition:

```bash
cat nodejs-provider/.env
```

You should see:
```env
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
DATABRICKS_ACCESS_TOKEN=dapi_your_token_here
DATABRICKS_DEFAULT_TABLE=workspace.default.koop_test_cities
DATABRICKS_GEOMETRY_COLUMN=geometry_wkt
DATABRICKS_ID_FIELD=objectid

# Authentication
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=test-token-12345
ENABLE_AUDIT_LOG=true
```

**To use your own Databricks instance:**
1. Copy `.env.example` to `.env`
2. Update with your credentials
3. Point to your table

### Step 3: Start the Test Server

```bash
cd testing
npm start
```

**Expected output:**
```
✅ Audit logging enabled: ./logs/audit.log
✅ Databricks Custom Data Provider initialized ✅
   Server: your-workspace.cloud.databricks.com
   Default table: workspace.default.koop_test_cities
   User auth: disabled
   Simple auth: ENABLED (testing only)
   Audit log: ENABLED
📊 Connection Pool initialized (min: 2, max: 10)

==============================================
Databricks Custom Data Provider Test Server
==============================================
Server running at: http://localhost:3000
Mock data mode: false

Endpoints:
  Info:   http://localhost:3000/
  Health: http://localhost:3000/health
  Query:  http://localhost:3000/query?table=...&f=geojson
  Viewer: http://localhost:3000/viewer.html

Example:
  curl "http://localhost:3000/query?table=catalog.schema.restaurants&f=geojson"
==============================================
```

### Step 4: Test the Server

Open a **new terminal** (keep the server running) and run these tests:

#### Test 1: Server Info
```bash
curl "http://localhost:3000/" | jq '.'
```

**Expected:**
```json
{
  "message": "Databricks Custom Data Provider Test Server",
  "authentication": {
    "simpleAuth": true,
    "userAuth": false,
    "auditLog": true
  },
  "endpoints": {...}
}
```

#### Test 2: Request WITHOUT Authentication (Should Fail)
```bash
curl "http://localhost:3000/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json"
```

**Expected:**
```json
{
  "error": "Unauthorized",
  "details": "Authorization required. Use: Authorization: Bearer <token>"
}
```

✅ **Authentication is working!**

#### Test 3: Request WITH Valid Token (Should Succeed)
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json"
```

**Expected:**
```json
{
  "count": 10,
  "filtersApplied": {
    "where": true,
    "geometry": false
  },
  "metadata": {...}
}
```

✅ **Query is working!**

#### Test 4: Get Actual Features
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&f=geojson" | jq '.features[0]'
```

**Expected:**
```json
{
  "type": "Feature",
  "id": 1,
  "properties": {
    "objectid": 1,
    "city_name": "San Francisco",
    "population": 874961,
    "state": "California",
    "srid": 4326
  },
  "geometry": {
    "type": "Point",
    "coordinates": [-122.4194, 37.7749]
  }
}
```

✅ **Features are returning correctly!**

#### Test 5: Filter Query (California Cities)
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&where=state='California'&f=geojson" | jq '.features | length'
```

**Expected:** `2` (San Francisco and Los Angeles)

#### Test 6: Pagination
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&resultRecordCount=3&resultOffset=0&f=geojson" | jq '.features | length'
```

**Expected:** `3` (first 3 cities)

#### Test 7: Sorting
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&orderByFields=population DESC&resultRecordCount=3&f=geojson" | jq '.features[0].properties | {city_name, population}'
```

**Expected:** Largest city first (New York or Los Angeles)

### Step 5: Check Audit Logs

```bash
cat nodejs-provider/logs/audit.log | jq '.'
```

**Expected output:**
```json
{"timestamp":"2026-02-03T22:30:00.000Z","event":"AUTH_FAILURE","username":"anonymous","method":"simple_token","ipAddress":"::1","success":false,"reason":"Missing or invalid authorization header"}
{"timestamp":"2026-02-03T22:30:15.000Z","event":"AUTH_SUCCESS","username":"simple_token_user","method":"simple_token","ipAddress":"::1","success":true}
{"timestamp":"2026-02-03T22:30:15.000Z","event":"QUERY","username":"simple_token_user","tableName":"workspace.default.koop_test_cities","queryParams":{"where":"none","returnCountOnly":true},"recordCount":10,"ipAddress":"::1"}
```

✅ **Audit logging is working!**

### Step 6: Test in Browser

Open your browser to: `http://localhost:3000/viewer.html`

**Note:** The viewer may need the Authorization header to be added manually, or you can temporarily disable auth for browser testing.

## Testing Your Own Table

To test with your own Databricks table:

### Option 1: Use Query Parameters
```bash
curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=your_catalog.your_schema.your_table&geometryColumn=your_geom_col&idField=your_id_col&f=geojson"
```

### Option 2: Update .env Default
Edit `nodejs-provider/.env`:
```env
DATABRICKS_DEFAULT_TABLE=your_catalog.your_schema.your_table
DATABRICKS_GEOMETRY_COLUMN=your_geom_col
DATABRICKS_ID_FIELD=your_id_col
```

Restart the server and test.

## Automated Test Script

We've included a test script. Run it:

```bash
cd testing
chmod +x test-requests.sh
./test-requests.sh
```

This tests all query types automatically.

## Troubleshooting

### Error: "Cannot find module 'dotenv'"

**Solution:**
```bash
cd nodejs-provider
npm install
cd ../testing
npm install
```

### Error: "Missing required Databricks configuration"

**Solution:** Check that `nodejs-provider/.env` exists and has all required values:
```bash
cat nodejs-provider/.env
```

### Error: "Connection refused" or "ECONNREFUSED"

**Causes:**
1. SQL Warehouse is stopped
2. Network/firewall blocking connection
3. Invalid credentials

**Solution:**
1. Check SQL Warehouse status in Databricks UI
2. Verify token is valid
3. Test connection directly from Databricks SQL Editor

### Error: "Table not found"

**Solution:** Verify table exists in Databricks:
```sql
SHOW TABLES IN workspace.default LIKE 'koop_test_cities';
SELECT * FROM workspace.default.koop_test_cities LIMIT 5;
```

### Server starts but queries hang

**Cause:** Connection pool waiting for SQL Warehouse to wake up

**Solution:** Wait 30-60 seconds for serverless warehouse to start, then retry

### Authentication not working

**Check environment variables:**
```bash
cd nodejs-provider
cat .env | grep ENABLE_SIMPLE_AUTH
# Should show: ENABLE_SIMPLE_AUTH=true
```

**Check token matches:**
```bash
cat .env | grep SIMPLE_AUTH_TOKEN
# Use this exact token in your curl commands
```

## Testing Different Authentication Modes

### Mode 1: No Authentication (Open Access)
Edit `nodejs-provider/.env`:
```env
ENABLE_SIMPLE_AUTH=false
ENABLE_USER_AUTH=false
```

Restart server. Queries work without Authorization header:
```bash
curl "http://localhost:3000/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json"
```

### Mode 2: Simple Token Auth (Development/Testing)
Edit `nodejs-provider/.env`:
```env
ENABLE_SIMPLE_AUTH=true
SIMPLE_AUTH_TOKEN=your-custom-token-here
ENABLE_USER_AUTH=false
```

Restart server. Queries require Authorization header:
```bash
curl -H "Authorization: Bearer your-custom-token-here" "http://localhost:3000/query?..."
```

### Mode 3: ArcGIS User Auth (Production)
Edit `nodejs-provider/.env`:
```env
ENABLE_SIMPLE_AUTH=false
ENABLE_USER_AUTH=true
```

This mode requires ArcGIS Server with `forwardUserIdentity: true` configured. Cannot test standalone.

## Performance Testing

### Test 1: Query 1000 Records
```bash
time curl -H "Authorization: Bearer test-token-12345" \
  "http://localhost:3000/query?table=workspace.default.koop_test_cities&resultRecordCount=1000&f=geojson" > /dev/null
```

### Test 2: Concurrent Requests
```bash
for i in {1..10}; do
  curl -H "Authorization: Bearer test-token-12345" \
    "http://localhost:3000/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json" &
done
wait
```

Watch connection pool in action (check server logs).

## Next Steps

Once local testing passes:

1. ✅ All query types work
2. ✅ Authentication works
3. ✅ Audit logs are created
4. ✅ Performance is acceptable

**You're ready to deploy to render.com or ArcGIS Server!**

See:
- **RENDER_DEPLOYMENT.md** - Deploy to render.com for quick testing
- **SECURITY_FEATURES.md** - Full security configuration guide
- **README.md** - Complete project documentation

## Stop the Server

Press `Ctrl+C` in the terminal running the server.

Or kill it:
```bash
pkill -f "node test-server.js"
```
# Deploy to Render.com

**Quick testing deployment using Databricks Community Edition (free account)**

This guide shows how to deploy your Custom Data Feed Provider to render.com for quick testing and demos. Perfect for:
- Testing with Databricks Community Edition (free tier)
- Sharing a working endpoint with colleagues
- Demo to stakeholders
- Development/testing before ArcGIS Server deployment

**⚠️ Note:** This is a **test server**, not a full ArcGIS Server deployment. For production, you'll deploy the `.cdpk` package to ArcGIS Server.

## Prerequisites

- GitHub account
- Render.com account (free tier works great!)
- Your code pushed to GitHub
- **Local testing completed** (see [LOCAL_TESTING.md](LOCAL_TESTING.md))

## Step 1: Push Code to GitHub

```bash
git add -A
git commit -m "Add render.com deployment support"
git push origin main
```

## Step 2: Create Web Service on Render.com

1. Go to [https://render.com](https://render.com) and sign in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository: `anandtrivedi/esri-customdatafeed`
4. Configure the service:

**Basic Settings:**
```
Name: databricks-custom-feed
Region: Oregon (US West) or closest to you
Branch: main
Root Directory: (leave blank)
Runtime: Node
Build Command: npm install
Start Command: npm start
```

**Instance Type:**
```
Free (or Starter if you need more resources)
```

## Step 3: Environment Variables

Click **"Advanced"** → **"Add Environment Variable"** and add these:

### Required Variables (Copy-Paste These):

```
PORT=3000
```

```
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
```

```
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id
```

```
DATABRICKS_ACCESS_TOKEN=dapi_your_token_here
```

```
DATABRICKS_DEFAULT_TABLE=workspace.default.koop_test_cities
```

```
DATABRICKS_GEOMETRY_COLUMN=geometry_wkt
```

```
DATABRICKS_ID_FIELD=objectid
```

```
DATABRICKS_SRID=4326
```

```
DATABRICKS_MAX_RECORD_COUNT=2000
```

### Security Settings (Copy-Paste These):

```
ENABLE_SIMPLE_AUTH=true
```

```
SIMPLE_AUTH_TOKEN=test-token-12345
```

```
ENABLE_USER_AUTH=false
```

```
ENABLE_AUDIT_LOG=true
```

```
AUDIT_LOG_FILE=./logs/audit.log
```

### Optional:

```
LOG_LEVEL=INFO
```

## Step 4: Deploy

Click **"Create Web Service"**

Render will:
- Clone your repository
- Run `npm install`
- Start the server with `npm start`
- Provide a public URL: `https://your-app-name.onrender.com`

Wait 2-3 minutes for build and deployment.

## Step 5: Test Your Deployment

Once deployed, you'll get a URL like: `https://databricks-custom-feed.onrender.com`

### Test 1: Check Server Info

```bash
curl "https://your-app-name.onrender.com/"
```

**Expected Response:**
```json
{
  "message": "Databricks Custom Data Provider Test Server",
  "mockData": false,
  "authentication": {
    "simpleAuth": true,
    "userAuth": false,
    "auditLog": true
  },
  "endpoints": {...}
}
```

### Test 2: Query Without Auth (Should Fail)

```bash
curl "https://your-app-name.onrender.com/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json"
```

**Expected Response:**
```json
{
  "error": "Unauthorized",
  "details": "Authorization required. Use: Authorization: Bearer <token>"
}
```

### Test 3: Query With Auth (Should Succeed)

```bash
curl -H "Authorization: Bearer test-token-12345" \
  "https://your-app-name.onrender.com/query?table=workspace.default.koop_test_cities&returnCountOnly=true&f=json"
```

**Expected Response:**
```json
{
  "count": 10,
  "filtersApplied": {...},
  "metadata": {...}
}
```

### Test 4: Get Features

```bash
curl -H "Authorization: Bearer test-token-12345" \
  "https://your-app-name.onrender.com/query?table=workspace.default.koop_test_cities&f=geojson"
```

**Expected Response:**
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": 1,
      "properties": {
        "objectid": 1,
        "city_name": "San Francisco",
        "population": 874961,
        "state": "California"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [-122.4194, 37.7749]
      }
    }
    // ... 9 more cities
  ],
  "metadata": {...}
}
```

## Step 6: Use in ArcGIS

Now you can add your render.com URL to ArcGIS clients:

### ArcGIS Online:
1. Go to Map Viewer
2. Add → Add Layer from URL
3. URL: `https://your-app-name.onrender.com/query?table=workspace.default.koop_test_cities`
4. Add custom header: `Authorization: Bearer test-token-12345`

### ArcGIS Pro:
1. Insert → Connections → New GeoJSON Connection
2. URL: `https://your-app-name.onrender.com/query?table=workspace.default.koop_test_cities&f=geojson`
3. Headers: `Authorization: Bearer test-token-12345`

## Troubleshooting

### Build Failed

**Check build logs in Render dashboard**

Common issues:
- Missing dependencies in package.json
- Node version mismatch

Solution: Verify `package.json` has all dependencies listed

### Server Starts But Queries Fail

**Check server logs in Render dashboard**

Common issues:
- Missing environment variables
- Databricks connection timeout
- Table doesn't exist

Solution:
1. Verify all environment variables are set correctly
2. Check Databricks warehouse is running
3. Verify table name is correct

### Authentication Always Fails

**Check environment variables**

- Verify `ENABLE_SIMPLE_AUTH=true`
- Verify `SIMPLE_AUTH_TOKEN` matches what you're sending
- Check Authorization header format: `Bearer <token>`

### No Data Returned

**Possible causes:**
1. Table doesn't exist in Databricks
2. Table is empty
3. SQL Warehouse is stopped

**Solution:**
Run this in Databricks SQL Editor to check:
```sql
-- Check if table exists
SHOW TABLES IN workspace.default LIKE 'koop_test_cities';

-- Count rows
SELECT COUNT(*) FROM workspace.default.koop_test_cities;

-- Check sample data
SELECT * FROM workspace.default.koop_test_cities LIMIT 5;
```

## Monitoring

### View Logs

In Render dashboard:
- Click on your service
- Go to "Logs" tab
- Watch real-time logs

### View Metrics

- CPU usage
- Memory usage
- Request count
- Response times

### Audit Logs

Audit logs are stored in `/logs/audit.log` but this is **ephemeral on render.com** (lost on restart).

For production, use external logging:
- Datadog
- Papertrail
- Loggly

## Upgrading

### Update Code

```bash
git add -A
git commit -m "Your changes"
git push origin main
```

Render automatically rebuilds and redeploys on push to main.

### Update Environment Variables

1. Go to Render dashboard
2. Click your service
3. Go to "Environment" tab
4. Update variables
5. Click "Save Changes"

Service automatically restarts with new variables.

## Cost

### Free Tier:
- ✅ 750 hours/month free
- ✅ Automatic HTTPS
- ✅ Auto-deploy on git push
- ⚠️ Spins down after 15 min inactivity (first request after may be slow)
- ⚠️ Limited to 512MB RAM

### Starter ($7/month):
- ✅ Always running (no spin down)
- ✅ More RAM/CPU
- ✅ Better for production

## Next Steps

1. **Create test data in Databricks** (if table doesn't exist)
2. **Test all query types** (where, spatial, pagination, etc.)
3. **Integrate with ArcGIS** (Online, Pro, or custom app)
4. **Monitor performance** and upgrade instance if needed
5. **Set up proper authentication** for production (ArcGIS user auth)

## Production Deployment

For production:

1. **Change authentication:**
   - Set `ENABLE_SIMPLE_AUTH=false`
   - Set `ENABLE_USER_AUTH=true`
   - Configure ArcGIS Server to forward user identity

2. **Use Service Principal instead of PAT:**
   - Create Databricks Service Principal
   - Use `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`

3. **Enable external logging:**
   - Use Datadog, Papertrail, or similar
   - Store audit logs externally

4. **Add monitoring:**
   - Set up alerts for errors
   - Monitor query performance
   - Track authentication failures

5. **Use custom domain:**
   - Configure custom domain in Render
   - Update ArcGIS connections

## Support

If you encounter issues:

1. Check Render logs
2. Test locally first: `npm start` in testing directory
3. Verify Databricks connection from local machine
4. Check GitHub Issues: https://github.com/anandtrivedi/esri-customdatafeed/issues

---

**You're now running your Databricks Custom Data Feed Provider as a standalone FeatureServer!**
