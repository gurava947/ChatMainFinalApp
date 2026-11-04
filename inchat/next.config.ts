import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page in this app is scoped to the signed-in user, so the authenticated
  // routes must render per request instead of being prerendered. Cache Components
  // prerenders all routes and forbids `dynamic`, so it stays off.
  cacheComponents: false,
  turbopack: {
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
