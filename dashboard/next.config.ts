import type { NextConfig } from "next"
import path from "node:path"

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: path.resolve(__dirname, ".."),
    resolveAlias: {
      "@composer": path.resolve(__dirname, "../src"),
    },
  },
  serverExternalPackages: ["zod"],
}

export default nextConfig
