import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
  transpilePackages: ["@agent-valley/core"],
  // libsql loads a native binding for the local state database.
  serverExternalPackages: ["zod", "@libsql/client"],
}

export default nextConfig
