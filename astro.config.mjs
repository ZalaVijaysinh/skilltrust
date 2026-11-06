import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://zalavijaysinh.github.io",
  base: "/skilltrust",
  output: "static",
  srcDir: "site/src",
  publicDir: "site/public",
  outDir: process.env.SKILLTRUST_OUT ?? "site/dist",
});
