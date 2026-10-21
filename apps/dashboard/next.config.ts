import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  transpilePackages: ["@agent-valley/core"],
  serverExternalPackages: ["zod"],
}

export default nextConfig
