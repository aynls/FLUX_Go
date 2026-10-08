import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      outputStructure: "locale-modules",
      emitTsDeclarations: true,
      emitGitIgnore: false,
      emitReadme: false,
      emitPrettierIgnore: false,
      strategy: ["custom-app", "baseLocale"],
      isServer: "false",
    }),
    react(),
    tailwindcss(),
  ],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.cache/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
