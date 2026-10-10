import fs from "node:fs";
fs.rmSync("dist/web/ui", { recursive: true, force: true });
fs.cpSync("src/web/ui", "dist/web/ui", { recursive: true });
console.log("copied UI assets to dist/web/ui");
