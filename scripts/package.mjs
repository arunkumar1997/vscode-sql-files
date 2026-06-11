#!/usr/bin/env node
// Build platform-specific VSIX packages for the File SQL extension.
//
// Why this exists:
//   `@duckdb/node-api` ships its native bindings as a set of
//   `optionalDependencies` (one per OS+arch). A plain `npm install` only
//   installs the binding matching the *host* machine, so a VSIX produced on
//   Windows would only contain `@duckdb/node-bindings-win32-x64` and fail on
//   macOS / Linux. The official VS Code answer is per-target VSIX files
//   published under the same extension ID — Marketplace serves the right
//   one to each user automatically.
//
// What this script does for a given target:
//   1. Ensure the JS bundles exist (`npm run build`).
//   2. Wipe every `node_modules/@duckdb/node-bindings-*` folder.
//   3. Install only the binding required by that target with
//      `npm install --no-save --force --omit=optional`.
//   4. Run `vsce package --target <target>` writing to `out/`.
//
// Usage:
//   node scripts/package.mjs --current
//   node scripts/package.mjs --target linux-x64
//   node scripts/package.mjs --all

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch as hostArch, platform as hostPlatform } from "node:os";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Map vsce target → DuckDB binding package name.
const TARGETS = {
    "win32-x64": "@duckdb/node-bindings-win32-x64",
    "win32-arm64": "@duckdb/node-bindings-win32-arm64",
    "linux-x64": "@duckdb/node-bindings-linux-x64",
    "linux-arm64": "@duckdb/node-bindings-linux-arm64",
    "darwin-x64": "@duckdb/node-bindings-darwin-x64",
    "darwin-arm64": "@duckdb/node-bindings-darwin-arm64",
};

function detectCurrentTarget() {
    const p = hostPlatform();
    const a = hostArch();
    const key = `${p === "win32" ? "win32" : p === "darwin" ? "darwin" : "linux"}-${a === "arm64" ? "arm64" : "x64"}`;
    if (!TARGETS[key]) {
        throw new Error(`Unsupported host platform: ${p}-${a}`);
    }
    return key;
}

function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.includes("--all")) return { mode: "all" };
    if (args.includes("--current")) return { mode: "current" };
    const tIdx = args.indexOf("--target");
    if (tIdx !== -1 && args[tIdx + 1]) {
        return { mode: "target", target: args[tIdx + 1] };
    }
    // Fallback: support `--target=linux-x64`
    for (const a of args) {
        if (a.startsWith("--target=")) return { mode: "target", target: a.slice("--target=".length) };
    }
    return { mode: "current" };
}

function run(cmd, args, opts = {}) {
    const printable = `${cmd} ${args.join(" ")}`;
    console.log(`\n$ ${printable}`);
    const res = spawnSync(cmd, args, {
        stdio: "inherit",
        cwd: repoRoot,
        shell: process.platform === "win32",
        ...opts,
    });
    if (res.status !== 0) {
        throw new Error(`Command failed (${res.status}): ${printable}`);
    }
}

function buildBundles() {
    // Always rebuild to be safe — esbuild bundling is fast and produces the
    // platform-independent JS that every VSIX shares.
    run("npm", ["run", "build"]);
}

function cleanBindings(exceptPkg) {
    const duckdbDir = join(repoRoot, "node_modules", "@duckdb");
    if (!existsSync(duckdbDir)) return;
    const keep = exceptPkg ? exceptPkg.split("/").pop() : null; // e.g. "node-bindings-linux-x64"
    for (const entry of readdirSync(duckdbDir)) {
        if (entry.startsWith("node-bindings-") && entry !== keep) {
            const full = join(duckdbDir, entry);
            console.log(`Removing ${full}`);
            rmSync(full, { recursive: true, force: true });
        }
    }
}

function installBinding(pkgName) {
    // Read the version expected by @duckdb/node-bindings so the swapped binding
    // stays in lock-step with the parent package.
    const bindingsPkgPath = join(repoRoot, "node_modules", "@duckdb", "node-bindings", "package.json");
    if (!existsSync(bindingsPkgPath)) {
        throw new Error(
            "Could not find node_modules/@duckdb/node-bindings/package.json — run `npm install` first.",
        );
    }
    const bindingsPkg = JSON.parse(readFileSync(bindingsPkgPath, "utf8"));
    const version = bindingsPkg.version;
    if (!version) {
        throw new Error("Could not read version from @duckdb/node-bindings/package.json");
    }
    // We deliberately do NOT pass --omit=optional: it strips esbuild's own
    // platform binary and breaks subsequent builds. Instead, we run a second
    // cleanup after install to remove any non-target bindings that npm may
    // have left in place because they happen to match the host's os/cpu.
    run("npm", [
        "install",
        "--no-save",
        "--force",
        "--ignore-scripts",
        `${pkgName}@${version}`,
    ]);
}

function packageVsix(target) {
    mkdirSync(join(repoRoot, "out"), { recursive: true });
    // Read version for output filename
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const outFile = join(repoRoot, "out", `file-sql-${target}-${pkg.version}.vsix`);
    run("npx", [
        "--no-install",
        "vsce",
        "package",
        "--target",
        target,
        "--out",
        outFile,
        "--allow-missing-repository",
        "--skip-license",
        "--allow-star-activation",
    ]);
}

async function buildForTarget(target) {
    if (!TARGETS[target]) {
        throw new Error(`Unknown target "${target}". Valid: ${Object.keys(TARGETS).join(", ")}`);
    }
    console.log(`\n=== Building ${target} ===`);
    buildBundles();
    cleanBindings(); // wipe all
    installBinding(TARGETS[target]);
    cleanBindings(TARGETS[target]); // npm may have re-added the host's binding
    packageVsix(target);
    console.log(`=== Done ${target} ===`);
}

async function main() {
    const { mode, target } = parseArgs(process.argv);
    try {
        if (mode === "all") {
            for (const t of Object.keys(TARGETS)) {
                await buildForTarget(t);
            }
        } else if (mode === "target") {
            await buildForTarget(target);
        } else {
            await buildForTarget(detectCurrentTarget());
        }
        console.log("\nAll requested VSIX files written to ./out");
    } catch (err) {
        console.error(`\n[package.mjs] ${err.message}`);
        process.exit(1);
    }
}

main();
