import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/docs",
  reactStrictMode: true,
  trailingSlash: true,
  turbopack: {
    root: path.resolve(appDirectory, "../.."),
  },
};

export default nextConfig;
