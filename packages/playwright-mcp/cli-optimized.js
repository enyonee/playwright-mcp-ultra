#!/usr/bin/env node
/**
 * Optimized CLI entry point.
 * Loads proxy middleware (batch, expectations, diff, filters, image)
 * before starting the standard Playwright MCP server.
 */
require('./src/setup-batch');
require('./cli');
