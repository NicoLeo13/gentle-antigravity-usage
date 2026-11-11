/**
 * Backfills subscription cost estimates into existing Pi session files.
 *
 * Sessions recorded before the provider priced turns carried cost.total = 0
 * while the token counts were already on every message, so the real cost is
 * recoverable: tokens x models.dev catalog rates, computed exactly the way
 * pi-ai's calculateCost does (including the 3.1 Pro >200k tier).
 *
 * Safety rules:
 * - Files whose mtime is younger than --min-age-seconds are skipped (an open
 *   Pi process may still append to them; a concurrent read-rewrite-rename
 *   could lose appended lines).
 * - Explicitly-open session paths can be passed via --open and are skipped.
 * - Only assistant messages of the antigravity-acp provider with zero cost
 *   and positive tokens are touched; anything else is left byte-identical.
 * - Files are rewritten atomically (temp file + rename), and only when at
 *   least one message changed. A .bak of the original is left beside it.
 *
 * Run: bun scripts/backfill-costs.ts [--root <dir>] [--min-age-seconds N] [--open path ...]
 */

import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const DEFAULT_ROOT = join(HOME, ".gentle-shell/agent/sessions");

// Catalog rates (USD per million tokens), mirroring the provider patch.
const FLASH = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const ARGON = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const PRO = {
	input: 2,
	output: 12,
	cacheRead: 0.2,
	cacheWrite: 0,
	tiers: [{ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0, inputTokensAbove: 200_000 }],
};
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: { input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }[] };

function ratesFor(model: string): Rates | undefined {
	const base = model.replace(/-(low|medium|high)$/u, "");
	if (/^gemini-3\.[678]-flash$/u.test(base)) return FLASH;
	if (/^gemini-4-argon$/u.test(base)) return ARGON;
	if (/^(gemini-3\.1-pro|gemini-pro-agent)$/u.test(base)) return PRO;
	return undefined;
}

/** Same arithmetic as pi-ai calculateCost: tier by combined input tokens, 1h cache writes charged at 2x base input. */
function computeCost(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, rates: Rates) {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let effective = rates as Rates;
	let matched = -1;
	for (const tier of rates.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			effective = tier;
			matched = tier.inputTokensAbove;
		}
	}
	const shortWrite = usage.cacheWrite;
	const cost = {
		input: (effective.input / 1_000_000) * usage.input,
		output: (effective.output / 1_000_000) * usage.output,
		cacheRead: (effective.cacheRead / 1_000_000) * usage.cacheRead,
		cacheWrite: (effective.cacheWrite * shortWrite) / 1_000_000,
	};
	return { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite, totalFromProvider: false };
}

const argv = process.argv.slice(2);
function option(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const root = resolve(option("--root") ?? DEFAULT_ROOT);
const minAge = Number(option("--min-age-seconds") ?? 120) * 1000;
const openPaths = new Set<string>();
for (let i = 0; i < argv.length; i++) if (argv[i] === "--open") openPaths.add(resolve(argv[i + 1] ?? ""));

function jsonlFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsonlFiles(path));
		else if (entry.name.endsWith(".jsonl") && !entry.name.endsWith(".bak.jsonl")) out.push(path);
	}
	return out;
}

let touchedFiles = 0;
let touchedMessages = 0;
let skippedActive = 0;
let skippedUnknown = 0;
let skippedUnsplittable = 0;
let alreadyPriced = 0;

for (const file of jsonlFiles(root)) {
	if (openPaths.has(file)) {
		console.log(`SKIP (open pane): ${basename(file)}`);
		continue;
	}
	if (Date.now() - statSync(file).mtimeMs < minAge) {
		skippedActive++;
		console.log(`SKIP (recently modified): ${basename(file)}`);
		continue;
	}
	const lines = readFileSync(file, "utf8").split("\n");
	let changed = false;
	let priced = 0;
	let unknown = 0;
	let unsplittable = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i]) continue;
		let entry: {
			type?: string;
			message?: { role?: string; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number; totalFromProvider?: boolean } } };
		};
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const message = entry.message;
		const usage = message?.usage;
		if (entry.type !== "message" || message?.role !== "assistant" || message.provider !== "antigravity-acp") continue;
		if (!usage || !usage.cost) continue;
		if ((usage.cost.total ?? 0) !== 0) {
			alreadyPriced++;
			continue;
		}
		const tokens = (usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite) || 0;
		if (tokens <= 0) continue;
		const categories = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (categories <= 0) {
			// Streaming toolUse updates sometimes report only a cumulative totalTokens
			// with no per-category split; pricing them would mean inventing a token
			// breakdown, so they stay as recorded.
			unsplittable++;
			continue;
		}
		const rates = ratesFor(message.model ?? "");
		if (!rates || rates === ZERO) {
			unknown++;
			continue;
		}
		usage.cost = computeCost({ input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }, rates);
		lines[i] = JSON.stringify(entry);
		changed = true;
		priced++;
	}
	skippedUnknown += unknown;
	skippedUnsplittable += unsplittable;
	if (!changed) continue;
	const backup = file + ".bak";
	copyFileSync(file, backup);
	const temp = file + ".backfill-tmp";
	writeFileSync(temp, lines.join("\n"));
	renameSync(temp, file);
	touchedFiles++;
	touchedMessages += priced;
	console.log(`BACKFILLED: ${basename(file)} (${priced} messages, backup ${basename(backup)})`);
}

console.log(`\nDone. ${touchedMessages} messages priced across ${touchedFiles} files.`);
console.log(`Already priced: ${alreadyPriced}, skipped active: ${skippedActive}, unknown model families: ${skippedUnknown}, unsplittable token counts: ${skippedUnsplittable}`);
