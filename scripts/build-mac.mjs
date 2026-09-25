import { spawnSync } from "node:child_process"

const architecture = process.env.RECORDS_MAC_ARCH || process.arch
if (!new Set(["arm64", "x64"]).has(architecture)) {
  throw new Error(`Unsupported macOS architecture: ${architecture}`)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, RECORDS_MAC_ARCH: architecture }
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

run("npm", ["run", "build"])
run("npm", ["run", "validate:vendor"])
run("npx", [
  "electron-builder",
  "--config",
  "electron-builder.config.cjs",
  "--mac",
  ...(process.argv.includes("--dist") ? ["dmg", "zip"] : ["--dir"]),
  `--${architecture}`,
  "--publish",
  "never"
])
