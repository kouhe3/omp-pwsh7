#!/usr/bin/env bun
/**
 * Vendor the `omp-kouhe3` fork's `@oh-my-pi/pi-coding-agent` as a local tarball
 * and repoint this extension's devDependency at it.
 *
 * Why a tarball: Bun's git dependencies cannot address a monorepo subdirectory
 * (a `git+…` spec installs the repo *root* under the requested name, and
 * `#path:` is not a commit-ish), and a plain `file:` to the package directory
 * fails because the on-repo manifest carries `catalog:` specifiers that only
 * resolve inside the workspace. Packing is the only route that yields a
 * consumer-ready manifest.
 *
 * Why the declaration pass: the on-repo manifest points `types` at
 * `./src/index.ts` (so `bun link` and source installs keep working). A consumer
 * typechecking against that source hits `TS2307` on the package's
 * `*.md`/`*.sh` imports, which only the repo's own tsconfig declares. We
 * therefore emit `dist/types` with the publish tsconfig and repoint the type
 * entries before packing — the same two steps `scripts/ci-release-publish.ts`
 * performs upstream.
 *
 * Usage:
 *   bun scripts/pack-fork-dep.ts [--fork <path>] [--vendor <dir>]
 *
 * The fork's `packages/coding-agent/package.json` is rewritten for the pack and
 * restored in a `finally`, so the fork checkout ends clean.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/** Fork checkout; override with `--fork` or `OMP_KOUHE3_DIR`. */
const DEFAULT_FORK = process.env.OMP_KOUHE3_DIR ?? "C:/tmp/omp-kouhe3";

/** Package inside the fork that holds the extension-facing types. */
const PACKAGE_DIR = "packages/coding-agent";

/** Manifest key/value types we repoint from `./src/*.ts` to `./dist/types/*.d.ts`. */
interface PackManifest {
	name?: string;
	version?: string;
	types?: string;
	exports?: Record<string, { types?: string } | string>;
	files?: string[];
}

/** The bits of this extension's manifest the script rewrites. */
interface ExtensionManifest {
	devDependencies: Record<string, string>;
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

/** `./src/tools/read.ts` → `./dist/types/tools/read.d.ts` */
function toDeclarationPath(spec: string): string {
	const relative = spec.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "");
	return `./dist/types/${relative}.d.ts`;
}

async function main(): Promise<void> {
	const fork = argValue("--fork") ?? DEFAULT_FORK;
	const extensionRoot = path.resolve(import.meta.dir, "..");
	const vendorArg = argValue("--vendor");
	const vendorDir = vendorArg ? path.resolve(vendorArg) : path.join(extensionRoot, "vendor");
	const packageDir = path.join(fork, PACKAGE_DIR);
	const manifestPath = path.join(packageDir, "package.json");

	const original = await fs.readFile(manifestPath, "utf8");
	// Named cast: this path is our own fork checkout's manifest, not external input.
	const sourceManifest = JSON.parse(original) as PackManifest;
	const version = sourceManifest.version ?? "0.0.0";
	const sha = (await $`git -C ${fork} rev-parse --short=8 HEAD`.text()).trim();

	try {
		// Declarations first: the pack must ship them, and the rewrite below
		// assumes `dist/types/index.d.ts` exists.
		await $`bun x tsgo -p tsconfig.publish.json`.cwd(packageDir);
		await fs.access(path.join(packageDir, "dist/types/index.d.ts"));

		const manifest = JSON.parse(original) as PackManifest;
		let rewrites = 0;
		if (manifest.types?.startsWith("./src/")) {
			manifest.types = toDeclarationPath(manifest.types);
			rewrites++;
		}
		for (const entry of Object.values(manifest.exports ?? {})) {
			if (typeof entry !== "object" || !entry.types?.startsWith("./src/")) continue;
			entry.types = toDeclarationPath(entry.types);
			rewrites++;
		}
		if (manifest.files && !manifest.files.includes("dist/types")) manifest.files.push("dist/types");
		if (rewrites === 0) throw new Error(`no ./src type entries rewritten in ${manifestPath}`);
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

		await fs.rm(vendorDir, { recursive: true, force: true });
		await fs.mkdir(vendorDir, { recursive: true });
		await $`bun pm pack --destination ${vendorDir}`.cwd(packageDir);

		const packed = path.join(vendorDir, `oh-my-pi-pi-coding-agent-${version}.tgz`);
		const vendored = path.join(vendorDir, `pi-coding-agent-${sha}.tgz`);
		await fs.rename(packed, vendored);

		const extensionManifestPath = path.join(extensionRoot, "package.json");
		// Named cast: our own manifest, read to swap exactly one specifier.
		const extensionManifest = (await Bun.file(extensionManifestPath).json()) as ExtensionManifest;
		extensionManifest.devDependencies["@oh-my-pi/pi-coding-agent"] = `file:vendor/${path.basename(vendored)}`;
		await Bun.write(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`);

		console.log(`packed ${path.relative(extensionRoot, vendored)} (fork ${sha}, v${version})`);
		console.log("next: bun install && bun run typecheck && bun test");
	} finally {
		// The rewrite mutates a tracked manifest; never leave the fork dirty.
		await fs.writeFile(manifestPath, original);
	}
}

await main();
