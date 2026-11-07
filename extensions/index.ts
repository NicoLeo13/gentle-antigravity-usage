import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Gentle Shell usage source for the Antigravity ACP provider.
 *
 * Gentle Shell's usage panel (`gentle-shell.ts`) registers custom sources by
 * validating a payload emitted on `gentle-pi:usage-source/v1`. The quota data
 * itself already exists in process: `pi-antigravity-acp-provider` answers
 * requests on `antigravity-acp:quota:request` with a snapshot parsed from the
 * official `agy /usage` reply. This extension only bridges the two — it never
 * talks to Google, holds no tokens, and owns no provider.
 */

/** Keys registered by gentle-shell's `parseUsageSource`; changing either side breaks the contract. */
const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

/** The provider id the Antigravity ACP models are routed under (`antigravity-acp/<model>`). */
const PROVIDER_ID = "antigravity-acp";

/** Request channel defined by pi-antigravity-acp-provider's `src/constants.ts`. */
const QUOTA_REQUEST_CHANNEL = "antigravity-acp:quota:request";

const MINUTE = 60;
const HOUR = 60 * MINUTE;const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

const KNOWN_WINDOWS: Record<string, number> = {
	weekly: WEEK,
	"5h": 5 * HOUR,
	daily: DAY,
	"24h": DAY,
	monthly: MONTH,
};

interface QuotaBucket {
	window: string;
	remainingFraction: number;
	resetTime?: string;
}

interface QuotaSnapshot {
	at: number;
	groups: { displayName: string; buckets: QuotaBucket[] }[];
}

interface QuotaRequestResult {
	ok: boolean;
	quota?: QuotaSnapshot;
	error?: string;
}

interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

interface ProviderUsage {
	provider: string;
	limits: { name: string; limitReached: boolean; windows: UsageWindow[] }[];
	fetchedAt: number;
}

/** Best effort: the panel needs a number to describe the window; unknown labels fall back to the common plan window. */
function windowSeconds(label: string): number {
	const direct = KNOWN_WINDOWS[label.trim().toLowerCase()];
	if (direct !== undefined) return direct;
	const named = /^(\d+)\s*([mhdw])$/i.exec(label.trim());
	if (named) {
		const amount = Number(named[1]);
		const unit = { m: MINUTE, h: HOUR, d: DAY, w: WEEK }[named[2]!.toLowerCase()];
		if (amount > 0 && unit !== undefined) return amount * unit;
	}
	return 5 * HOUR;
}

function windowLabel(seconds: number, raw: string): string {
	if (seconds === WEEK) return "week";
	if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
	if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
	return raw;
}

function parseResetAt(resetTime?: string): number | null {
	if (!resetTime) return null;
	const epoch = Date.parse(resetTime);
	return Number.isFinite(epoch) ? Math.floor(epoch / 1000) : null;
}

/** Ask the ACP provider for a snapshot; resolves undefined when it is absent or times out. */
function requestQuotaSnapshot(pi: ExtensionAPI, timeoutMs: number): Promise<QuotaSnapshot | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), timeoutMs);
		const payload = { reply: (result: QuotaRequestResult | undefined) => {
			clearTimeout(timer);
			resolve(result?.ok ? result.quota : undefined);
		} };
		try {
			void pi.events.emit(QUOTA_REQUEST_CHANNEL, payload);
		} catch {
			clearTimeout(timer);
			resolve(undefined);
		}
	});
}

/** Rebuilds the provider's sharing shape into gentle-shell's validated usage shape. */
function snapshotToUsage(snapshot: QuotaSnapshot, now: number): ProviderUsage {
	const limits = [];
	for (const group of snapshot.groups) {
		const windows: UsageWindow[] = [];
		for (const bucket of group.buckets) {
			if (typeof bucket.remainingFraction !== "number") continue;
			const seconds = windowSeconds(bucket.window);
			windows.push({
				label: windowLabel(seconds, bucket.window),
				usedPercent: Math.round(Math.min(100, Math.max(0, (1 - bucket.remainingFraction) * 100)) * 100) / 100,
				windowSeconds: seconds,
				resetAt: parseResetAt(bucket.resetTime),
			});
		}
		if (windows.length) limits.push({ name: group.displayName, limitReached: windows.every((window) => window.usedPercent >= 100), windows });
	}
	return { provider: PROVIDER_ID, limits, fetchedAt: now };
}

/** Registers (and re-registers) the usage source so gentle-shell picks it up after its own factory loaded. */
function announceSource(pi: ExtensionAPI): void {
	const source = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: PROVIDER_ID,
		pendingNote: "asks Antigravity on refresh",
		fetch: async (_apiKey: string | undefined, _fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> => {
			// The fetchFn argument stays unused: the quota snapshot already exists in process.
			const snapshot = await requestQuotaSnapshot(pi, 15_000);
			return snapshot ? snapshotToUsage(snapshot, now) : undefined;
		},
	};
	void pi.events.emit(USAGE_SOURCE_EVENT, source);
}

export default function antigravityUsageExtension(pi: ExtensionAPI): void {
	// gentle-shell listens on this channel before any session_start of ours
	// fires, so announcing from here can never fall before its subscription.
	pi.on("session_start", () => announceSource(pi));
}
