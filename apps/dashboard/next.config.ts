import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  transpilePackages: ["@agent-valley/core"],
  serverExternalPackages: ["zod"],
  typescript: {
    ignoreBuildErrors: true,
  },
}

export default nextConfig
