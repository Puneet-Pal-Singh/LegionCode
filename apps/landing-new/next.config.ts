import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  transpilePackages: ["motion"],
  turbopack: {
    root: path.resolve(appDirectory, "../.."),
  },
};

export default nextConfig;
