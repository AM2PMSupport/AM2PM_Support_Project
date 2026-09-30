import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-postgres has optional native bindings; load it from node_modules at
  // runtime instead of bundling it.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
