import { Arch, type Configuration } from "electron-builder";
import { join } from "node:path";
import {
  buildNativeFileHelper,
  minimumMacOSVersion,
  nativeHelperSources,
  inspectNativeFileHelper,
  verifyPackagedMacOSMinimum,
  verifyBundledFileHelper,
  verifyBundledHostBroker,
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
      if (context.electronPlatformName === "darwin") {
        const brokerDiagnostics = await verifyBundledHostBroker(
          join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            "Contents", "Resources", "native", "legioncode-host-broker",
          ),
          context.electronPlatformName,
          Arch[context.arch],
        );
        console.info(JSON.stringify({
          helper: "legioncode-host-broker",
          stage: "bundled-link-inspected-before-signing",
          ...brokerDiagnostics,
        }));
        await inspectNativeFileHelper(join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents", "Resources", "native", "legioncode-native-installer",
        ), context.electronPlatformName, Arch[context.arch]);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown verifier failure";
      throw new Error(`Packaged native helper verification failed: ${detail}`, { cause: error });
    }
  },
  npmRebuild: true,
  asarUnpack: ["**/node_modules/better-sqlite3/**"],
  directories: {
    output: "release",
  },
  files: ["out/**/*", "package.json"],
  mac: {
    icon: "../web/public/assets/legioncode-icon-512.png",
    minimumSystemVersion: minimumMacOSVersion,
    category: "public.app-category.developer-tools",
    target: ["dmg", "zip"],
  },
  artifactName: "${productName}-${version}-${arch}.${ext}",
};

export default config;
