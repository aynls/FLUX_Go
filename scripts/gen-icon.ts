import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The header mark and native icons share this SVG geometry.
const root = join(import.meta.dir, "..");
const mark = readFileSync(join(root, "public", "brand", "mark.svg"), "utf8");
const geometry = mark.match(/<path\s[^>]*\/>/g)?.join("\n");
if (!geometry) throw new Error("Brand mark contains no paths");

const source = join(root, "public", "brand", "app-icon.svg");
writeFileSync(source, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#202522"/>
  <g transform="translate(4 4) scale(1.75)" fill="#f2f1e9" color="#f2f1e9">
    ${geometry}
  </g>
</svg>
`);

const result = Bun.spawnSync(["bun", "run", "tauri", "icon", source, "--output", join(root, "src-tauri", "icons")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) process.exit(result.exitCode);
