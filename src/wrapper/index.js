/**
 * @file src/wrapper/index.js
 * @description Entry point — creates and starts the MCP server launcher.
 */

import { McpServerLauncher } from './McpServerLauncher.js';

(new McpServerLauncher()).start();
