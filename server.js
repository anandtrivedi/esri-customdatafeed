/**
 * server.js
 * Production server entry point for render.com deployment
 *
 * This runs the test server as a standalone service
 */

// Change to testing directory and start server
process.chdir(__dirname + '/testing');
require('./testing/test-server.js');
