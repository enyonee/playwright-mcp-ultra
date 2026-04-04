/**
 * Optimized library entry point.
 * Loads proxy middleware (batch, expectations, diff, filters, image)
 * before exporting the standard Playwright MCP connection.
 */
require('./src/setup-batch');
module.exports = require('./index');
