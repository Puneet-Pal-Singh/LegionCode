import { Arch, type Configuration } from "electron-builder";
import { join } from "node:path";
import {
  buildNativeFileHelper,
  minimumMacOSVersion,
  nativeHelperSources,
  verifyPackagedMacOSMinimum,
  verifyBundledFileHelper,
} from "./scripts/build-file-helper.mjs";

import { verifyBundledProcessHelper } from "./scripts/verify-process-helper.mjs";

const config: Configuration = {
  appId: "dev.legioncode.desktop",
  productName: "LegionCode Desktop",
  asar: true,
  beforePack: async (context) => {
    try {
      for (const { name, sourcePath } of nativeHelperSources) {
        const diagnostics = await buildNativeFileHelper(
          sourcePath,
          context.electronPlatformName,
          Arch[context.arch],
          name,
        );
        console.info(
          JSON.stringify({ helper: name, stage: "compiled", ...diagnostics }),
        );
      }
    } catch {
      throw new Error("Native helper compilation failed");
    }
  },
  extraResources: nativeHelperSources.map(({ name }) => ({
    from: `native-bin/${name}`,
    to: `native/${name}`,
  })),
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
      const processDiagnostics = await verifyBundledProcessHelper(
        join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
          "native",
          "legioncode-process-helper",
        ),
        context.electronPlatformName,
        Arch[context.arch],
      );
      console.info(
        JSON.stringify({
          helper: "legioncode-process-helper",
          stage: "bundled-before-signing",
          ...processDiagnostics,
        }),
      );
    } catch {
      throw new Error("Packaged native helper verification failed");
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
