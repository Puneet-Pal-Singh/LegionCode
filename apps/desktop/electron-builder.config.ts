import { Arch, type Configuration } from "electron-builder";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNativeFileHelper,
  minimumMacOSVersion,
  verifyPackagedMacOSMinimum,
  verifyBundledFileHelper,
} from "./scripts/build-file-helper.mjs";

const sourcePath = fileURLToPath(
  new URL(
    "../../packages/execution-engine/src/runtime/desktop/native/legioncode-fs-helper.c",
    import.meta.url,
  ),
);

const config: Configuration = {
  appId: "dev.legioncode.desktop",
  productName: "LegionCode Desktop",
  asar: true,
  beforePack: async (context) => {
    try {
      const diagnostics = await buildNativeFileHelper(
        sourcePath,
        context.electronPlatformName,
        Arch[context.arch],
      );
      console.info(
        JSON.stringify({
          helper: "legioncode-fs-helper",
          stage: "compiled",
          ...diagnostics,
        }),
      );
    } catch {
      throw new Error("Native filesystem helper compilation failed");
    }
  },
  extraResources: [
    {
      from: "native-bin/legioncode-fs-helper",
      to: "native/legioncode-fs-helper",
    },
  ],
  afterPack: async (context) => {
    const helperPath = join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
      "native",
      "legioncode-fs-helper",
    );
    try {
      await verifyPackagedMacOSMinimum(
        join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Info.plist",
        ),
      );
      const diagnostics = await verifyBundledFileHelper(
        helperPath,
        context.electronPlatformName,
        Arch[context.arch],
      );
      console.info(
        JSON.stringify({
          helper: "legioncode-fs-helper",
          stage: "bundled-before-signing",
          ...diagnostics,
        }),
      );
    } catch {
      throw new Error("Packaged native filesystem helper verification failed");
    }
  },
  npmRebuild: true,
  asarUnpack: ["**/node_modules/better-sqlite3/**"],
  directories: {
    output: "release",
  },
  files: ["out/**/*", "package.json"],
  mac: {
    minimumSystemVersion: minimumMacOSVersion,
    category: "public.app-category.developer-tools",
    target: ["dmg", "zip"],
  },
  artifactName: "${productName}-${version}-${arch}.${ext}",
};

export default config;
