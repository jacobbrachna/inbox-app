import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output: emits .next/standalone/server.js with only the
  // runtime deps Next.js actually needs. We bundle that into the Tauri
  // .app along with a Node binary so the user never has to install
  // Node/npm/dependencies themselves.
  output: "standalone",

  // Native deps that Next.js can't bundle through webpack (better-sqlite3
  // has a .node binary; Prisma has a platform-specific query engine).
  // Marked external so they resolve at runtime via standalone's
  // node_modules instead of being inlined.
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
    "prisma",
  ],
};

export default nextConfig;
