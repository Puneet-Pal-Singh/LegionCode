import type { Configuration } from "electron-builder";

const config: Configuration = {
  appId: "dev.legioncode.desktop",
  productName: "LegionCode Desktop",
  asar: true,
  directories: {
    output: "release",
  },
  files: ["out/**/*", "package.json"],
  mac: {
    category: "public.app-category.developer-tools",
    target: ["dmg", "zip"],
  },
  artifactName: "${productName}-${version}-${arch}.${ext}",
};

export default config;
