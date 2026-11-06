#!/usr/bin/env node
// Applies this fork's customizations to an upstream checkout.
//
// Usage: node fork/apply-customizations.mjs --repo <owner/repo> --version <x.y.z-n>
//
// Every edit is anchored to an exact upstream string and asserted; if upstream moves the
// code, this script fails loudly instead of silently shipping a build without the patch.

import * as fs from "node:fs";
import * as path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	const key = process.argv[i];
	const value = process.argv[i + 1];
	if (!key?.startsWith("--") || value === undefined) {
		throw new Error(`bad argument: ${key}`);
	}
	args.set(key.slice(2), value);
}

const repo = args.get("repo");
const version = args.get("version");
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
	throw new Error("--repo owner/repo is required");
}
if (!version || !/^\d+\.\d+\.\d+-\d+$/.test(version)) {
	throw new Error("--version <x.y.z-n> is required");
}

const root = process.cwd();
const edits = [];

if (fs.readFileSync(path.join(root, "packages/coding-agent/src/cli/build-service.ts"), "utf8").includes("FORK_GITHUB_REPO")) {
	throw new Error("customizations are already applied; reset the tree (git checkout -- .) before re-running");
}

function read(rel) {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

function write(rel, text) {
	fs.writeFileSync(path.join(root, rel), text);
	edits.push(rel);
}

function replace(rel, from, to, { regex = false } = {}) {
	const original = read(rel);
	const next = regex ? original.replace(from, to) : original.split(from).join(to);
	if (next === original) {
		throw new Error(`anchor not found in ${rel}: ${String(from).slice(0, 120)}`);
	}
	write(rel, next);
}

// 1) Auto session titles in ACP: drop the ACP clause from the PI_NO_TITLE gate and let the
//    session enable autoTitle outside the interactive TUI. Air receives the generated title
//    through the existing session_info_update notification.
replace(
	"packages/coding-agent/src/main.ts",
	/(parsedArgs\.noTitle \|\|\s*parsedArgs\.mode === "rpc" \|\|\s*parsedArgs\.mode === "rpc-ui")(\s*\|\|\s*parsedArgs\.mode === "acp")/,
	"$1",
	{ regex: true },
);
replace(
	"packages/coding-agent/src/main.ts",
	"options.autoTitle = isInteractive;",
	'options.autoTitle = isInteractive || mode === "acp";',
);

// 2) Native addon fallback downloads come from this fork's releases instead of upstream's.
replace(
	"packages/natives/native/loader-state.js",
	"https://github.com/can1357/oh-my-pi/releases/latest/download/",
	`https://github.com/${repo}/releases/latest/download/`,
);

// 3) Self-update: compiled binaries normally ask build.stencil.so. With FORK_GITHUB_REPO set,
//    fetchBuild() resolves the same BuildAnswer shape from this fork's GitHub Releases.
const buildService = "packages/coding-agent/src/cli/build-service.ts";
const forkHelper = `
/**
 * Fork build channel: answer {@link fetchBuild} from this repository's GitHub Releases.
 *
 * Assets are published by .github/workflows/fork-release.yml as \`omp-<target>\` plus a
 * sibling \`omp-<target>.sha256\`, so the existing download/verify path is unchanged.
 */
const FORK_GITHUB_REPO = ${JSON.stringify(repo)};

async function fetchForkBuild(
	repoName: string,
	selector: BuildSelector,
	host: BuildHost,
	options: FetchBuildOptions,
): Promise<BuildAnswer> {
	const doFetch: Fetch = options.fetchImpl ?? fetch;
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": \`\${APP_NAME}/\${VERSION}\`,
	};
	const signal = AbortSignal.timeout(options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS);
	const base = \`https://api.github.com/repos/\${repoName}/releases\`;
	const endpoint = "channel" in selector ? \`\${base}/latest\` : \`\${base}/tags/v\${selector.version}\`;
	const response = await doFetch(endpoint, { headers, signal });
	if (!response.ok) {
		throw new Error(\`Failed to fetch fork release: \${response.status} \${response.statusText}\`);
	}
	const release = (await response.json()) as {
		tag_name?: unknown;
		assets?: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown }>;
	};
	const tag = typeof release.tag_name === "string" ? release.tag_name : "";
	const resolved = tag.replace(/^v/, "");
	if (!SEMVER.test(resolved)) {
		throw new Error(\`Fork release \${tag || "(untagged)"} has no valid version\`);
	}
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const asset = assets.find(a => a.name === host.fileName);
	if (!asset || typeof asset.browser_download_url !== "string" || !isSize(asset.size)) {
		throw new Error(\`Fork release \${tag} has no usable asset \${host.fileName}\`);
	}
	const checksumAsset = assets.find(a => a.name === \`\${host.fileName}.sha256\`);
	if (!checksumAsset || typeof checksumAsset.browser_download_url !== "string") {
		throw new Error(\`Fork release \${tag} has no \${host.fileName}.sha256\`);
	}
	const checksumResponse = await doFetch(checksumAsset.browser_download_url, { headers, signal });
	if (!checksumResponse.ok) {
		throw new Error(\`Failed to fetch \${host.fileName}.sha256: \${checksumResponse.status}\`);
	}
	const sha256 = (await checksumResponse.text()).trim().split(/\\s+/)[0]?.toLowerCase() ?? "";
	if (!isSha256(sha256)) {
		throw new Error(\`Fork release \${tag} has an invalid sha256\`);
	}
	return {
		version: resolved,
		file: { name: host.fileName, size: asset.size, sha256 },
		download: asset.browser_download_url,
	};
}

`;

const buildServiceText = read(buildService);
const insertAt = buildServiceText.indexOf(
	"/** Ask the build service for a build of this host's target ({@link BuildSelector}). */",
);
if (insertAt < 0) {
	throw new Error("anchor not found in build-service.ts: fetchBuild doc comment");
}
write(
	buildService,
	buildServiceText.slice(0, insertAt) + forkHelper + buildServiceText.slice(insertAt),
);
replace(
	buildService,
	"const host = options.host ?? (await currentBuildHost());",
	"const host = options.host ?? (await currentBuildHost());\n\tif (FORK_GITHUB_REPO) return fetchForkBuild(FORK_GITHUB_REPO, selector, host, options);",
);

// 4) Push auto-generated titles to ACP clients. The generator sets the session name
//    asynchronously after end-of-turn updates, so subscribe to name changes and emit
//    session_info_update ourselves (this is also what /rename does explicitly).
const acpAgent = "packages/coding-agent/src/modes/acp/acp-agent.ts";
replace(
	acpAgent,
	"\tlifetimeUnsubscribe: (() => void) | undefined;",
	"\tlifetimeUnsubscribe: (() => void) | undefined;\n\ttitleUnsubscribe: (() => void) | undefined;",
);
replace(
	acpAgent,
	"\t\t\tlifetimeUnsubscribe: undefined,",
	"\t\t\tlifetimeUnsubscribe: undefined,\n\t\t\ttitleUnsubscribe: undefined,",
);
replace(
	acpAgent,
	"\t\t\trecord.lifetimeUnsubscribe = unsubscribeEvents;",
	"\t\t\trecord.lifetimeUnsubscribe = unsubscribeEvents;\n" +
		"\t\t\t// Auto-generated titles land after end-of-turn updates; push them so ACP clients\n" +
		"\t\t\t// (and Air) see the generated name without waiting for a rename.\n" +
		"\t\t\trecord.titleUnsubscribe = session.sessionManager.onSessionNameChanged(() => {\n" +
		"\t\t\t\tvoid this.#connection\n" +
		"\t\t\t\t\t.sessionUpdate({\n" +
		"\t\t\t\t\t\tsessionId: record.protocolSessionId,\n" +
		"\t\t\t\t\t\tupdate: {\n" +
		"\t\t\t\t\t\t\tsessionUpdate: \"session_info_update\",\n" +
		"\t\t\t\t\t\t\ttitle: record.session.sessionName,\n" +
		"\t\t\t\t\t\t\tupdatedAt: new Date().toISOString(),\n" +
		"\t\t\t\t\t\t},\n" +
		"\t\t\t\t\t})\n" +
		"\t\t\t\t\t.catch(() => {});\n" +
		"\t\t\t});",
);
replace(
	acpAgent,
	"\t\trecord.lifetimeUnsubscribe?.();",
	"\t\trecord.lifetimeUnsubscribe?.();\n\t\trecord.titleUnsubscribe?.();",
);

// 5) Version bump: every workspace package + the root catalog pin must move together, otherwise
//    bun links the published 18.x packages instead of the local workspace builds.
const baseVersion = version.replace(/-\d+$/, "");
const versionPattern = new RegExp(`("version"\\s*:\\s*")${baseVersion.replace(/\./g, "\\.")}(")`);
const packagesDir = path.join(root, "packages");
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const manifest = path.join("packages", entry.name, "package.json");
	const abs = path.join(root, manifest);
	if (!fs.existsSync(abs)) continue;
	const text = fs.readFileSync(abs, "utf8");
	if (!versionPattern.test(text)) continue;
	fs.writeFileSync(abs, text.replace(versionPattern, `$1${version}$2`));
	edits.push(manifest);
}

const rootManifest = "package.json";
const rootText = read(rootManifest);
let nextRoot = rootText;
const rootData = JSON.parse(rootText);
for (const [name, value] of Object.entries(rootData.workspaces?.catalog ?? {})) {
	if (!name.startsWith("@oh-my-pi/") || value !== baseVersion) continue;
	nextRoot = nextRoot.split(`"${name}": "${baseVersion}"`).join(`"${name}": "${version}"`);
}
if (nextRoot !== rootText) {
	fs.writeFileSync(path.join(root, rootManifest), nextRoot);
	edits.push(rootManifest);
}

const unique = [...new Set(edits)];
console.log(`applied ${unique.length} edits for ${repo}@${version}:`);
for (const file of unique) console.log(`  ${file}`);
