// Entry point: `npm start`.

import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);
const server = createServer((req, res) => app.handle(req, res));
server.keepAliveTimeout = 65000;

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
  console.log(`MP4 Grabber Library is running at http://${shown}:${config.port}`);
  console.log(`Data is stored in ${config.dataDir}`);
});

function shutdown() {
  server.close();
  app.close();
  // SSE connections stay open by design; don't wait for them.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
