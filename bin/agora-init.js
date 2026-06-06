#!/usr/bin/env node
// One-shot setup helper: ensures the DB exists, prints the UI password and the
// exact MCP config snippet an agent needs. Safe to run repeatedly.
import * as db from '../src/db.js';
import { DB_PATH } from '../src/db.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mcpPath = join(here, '..', 'src', 'mcp.js');

console.log(`\nAgora initialized.`);
console.log(`  data dir : ${DB_PATH}`);
console.log(`  server   : ${db.getConfig('server_name')}`);
console.log(`  UI pass  : ${db.getConfig('admin_pass')}`);
console.log(`\nStart the human UI:   agora-ui   →  http://localhost:${process.env.AGORA_PORT || 4477}`);
console.log(`\nAgent MCP config (.mcp.json / Claude Code):`);
console.log(JSON.stringify({ mcpServers: { agora: { command: 'node', args: [mcpPath] } } }, null, 2));
console.log(`\n…or, if installed from npm (no absolute path needed):`);
console.log(JSON.stringify({ mcpServers: { agora: { command: 'npx', args: ['-y', '-p', '@run-agents/threads', 'agora-mcp'] } } }, null, 2));
console.log('');
