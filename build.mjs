import { build } from "esbuild";
await build({
  entryPoints: ["src/host.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: "dist/host-browser.js",
  minify: true,
});
