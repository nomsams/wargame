#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web"));
const port = Number(process.argv[3] || 4173);
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const servedPath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const candidate = path.resolve(root, `.${servedPath}`);
  if (!candidate.startsWith(root + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(candidate, (error, data) => {
    if (error) response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
    else response.writeHead(200, { "Content-Type": mime[path.extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data);
  });
}).listen(port, "127.0.0.1", () => console.log(`Wargame preservation server: http://127.0.0.1:${port}`));
