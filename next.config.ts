import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: emits a folder of plain HTML/CSS/JS in /out. No
  // server. Electron loads index.html via its app:// protocol and
  // intercepts /api/* fetches to route them to backend handlers in
  // electron/api/ — see electron/main.js.
  output: "export",
  // file:// loading + custom protocols don't have a real origin, so
  // disable image optimization (it relies on a server route).
  images: { unoptimized: true },
  // The UI hits /api/X paths via relative fetch. With trailing slash
  // disabled the URLs stay clean (/api/state, not /api/state/).
  trailingSlash: false,
};

export default nextConfig;
