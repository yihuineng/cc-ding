#!/usr/bin/env node
/**
 * A2A Hub - Standalone entry point
 *
 * Usage:
 *   A2A_HUB_API_KEY=secret node dist/bin/a2a-hub.js
 *   A2A_HUB_PORT=3002 A2A_HUB_API_KEY=secret node dist/bin/a2a-hub.js
 */

import { A2AHub, IHubConfig } from '../src/biz/a2a/hub';

function loadConfig(): IHubConfig {
  const port = parseInt(process.env.A2A_HUB_PORT || '3002', 10);
  const apiKey = process.env.A2A_HUB_API_KEY || '';
  const heartbeatTimeout = parseInt(process.env.A2A_HUB_HEARTBEAT || '60', 10);

  if (!apiKey) {
    console.error('Error: A2A_HUB_API_KEY environment variable is required');
    console.error('Usage: A2A_HUB_API_KEY=your-secret-key node dist/bin/a2a-hub.js');
    console.error('');
    console.error('Note: Port defaults to 3002 if A2A_HUB_PORT is not set');
    process.exit(1);
  }

  return { port, apiKey, heartbeatTimeout };
}

const config = loadConfig();

console.log('[Hub] Starting A2A Hub...');
console.log(`[Hub] Port: ${config.port}`);
console.log(`[Hub] API Key: ${config.apiKey ? '***' + config.apiKey.slice(-4) : '(none)'}`);
console.log(`[Hub] Heartbeat timeout: ${config.heartbeatTimeout}s`);

const hub = new A2AHub(config);
hub.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Hub] Shutting down...');
  hub.stop().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n[Hub] Shutting down...');
  hub.stop().then(() => process.exit(0));
});
