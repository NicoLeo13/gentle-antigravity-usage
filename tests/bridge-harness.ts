/**
 * Harness test (run with: bun tests/bridge-harness.ts)
 *
 * Simulates gentle-shell's usage-source subscription on one end and the ACP
 * provider's quota handler on the other, then drives the real bridge
 * extension. Asserts the emitted usage payload validates against the same
 * rules gentle-shell applies in lib/shell-usage.ts.
 */

import { EventEmitter } from "node:events";

const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
const QUOTA_REQUEST_CHANNEL = "antigravity-acp:quota:request";

const bus = new EventEmitter();

type ProviderUsage = {
	provider: string;
	limits: { name: string; limitReached: boolean; windows: unknown[] }[];
	fetchedAt: number;
};

let captured: { source: unknown } | undefined;

// --- gentle-shell side: validate registration payload like parseUsageSource ---
bus.on(USAGE_SOURCE_EVENT, (payload: unknown) => {
	const raw = payload as Record<string, unknown>;
	if (!raw || raw.schema !== "gentle-pi.usage-source/v1") throw new Error("invalid schema in emitted source");
	if (raw.provider !== "antigravity-acp") throw new Error(`wrong provider: ${raw.provider}`);
	if (typeof raw.fetch !== "function") throw new Error("fetch is not a function");
	if (typeof raw.pendingNote !== "string") throw new Error("pendingNote not a string");
	captured = { source: payload as { source: unknown } };
});

// --- ACP provider side: reply with the snapshot shape from usage-quota.ts ---
bus.on(QUOTA_REQUEST_CHANNEL, (payload: { reply: (r: unknown) => void }) => {
	payload.reply({
		ok: true,
		quota: {
			at: Date.now(),
			groups: [
				{
					displayName: "Gemini 3 Pro",
					buckets: [
						{ window: "5h", remainingFraction: 0.42, resetTime: "2026-11-06T23:00:00.000Z" },
						{ window: "weekly", remainingFraction: 0.91, resetTime: "2026-11-09T00:00:00.000Z" },
					],
				},
			],
		},
	});
});

// --- minimal ExtensionAPI mock covering what the bridge uses ---
type Handler = (data: unknown) => void;
const pi = {
	events: {
		emit: (channel: string, data: unknown) => bus.emit(channel, data),
		on: (channel: string, handler: Handler) => {
			bus.on(channel, handler as (data: unknown) => void);
			return () => bus.off(channel, handler as (data: unknown) => void);
		},
	},
	on: (event: string, handler: (data: unknown, ctx?: unknown) => void) => {
		handlers[event] = handler;
	},
} as never;
const handlers: Record<string, (data: unknown, ctx?: unknown) => void> = {};

const { default: extension } = await import("../extensions/index.ts");
extension(pi);
if (!handlers["session_start"]) throw new Error("extension did not subscribe to session_start");

handlers["session_start"]({}); // fires announceSource
if (!captured) throw new Error("no usage source arrived on USAGE_SOURCE_EVENT");

// --- run the fetch gentle-shell would call ---
const source = captured.source as unknown as {
	fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<ProviderUsage | undefined>;
};
const usage = await source.fetch(undefined, fetch, Date.now());
if (!usage) throw new Error("fetch returned undefined");
if (usage.provider !== "antigravity-acp") throw new Error(`fetch wrong provider: ${usage.provider}`);
if (!Number.isFinite(usage.fetchedAt)) throw new Error("fetchedAt not finite");

// parseProviderUsage rules: every field checked, windows rebuilt
const [limit] = usage.limits;
if (!limit || limit.name !== "Gemini 3 Pro" || limit.limitReached !== false) throw new Error("limit mismatch");
const [h5, week] = limit.windows as { label: string; usedPercent: number; windowSeconds: number; resetAt: number | null }[];
if (!h5 || h5.label !== "5h" || h5.windowSeconds !== 18000 || h5.usedPercent !== 58) throw new Error(`5h bucket wrong: ${JSON.stringify(h5)}`);
if (!week || week.label !== "week" || week.windowSeconds !== 604800 || week.usedPercent !== 9) throw new Error(`weekly bucket wrong: ${JSON.stringify(week)}`);
if (h5.resetAt !== Math.floor(Date.parse("2026-11-06T23:00:00.000Z") / 1000)) throw new Error(`resetAt wrong: ${h5.resetAt}`);
if (week.resetAt !== Math.floor(Date.parse("2026-11-09T00:00:00.000Z") / 1000)) throw new Error(`resetAt wrong: ${week.resetAt}`);

console.log("bridge-harness: OK", JSON.stringify(usage, null, 2));
