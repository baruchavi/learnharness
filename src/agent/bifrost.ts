import { createHash } from "node:crypto";
import { createProvider, type Model, type Provider, type ThinkingLevelMap, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const TTL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
class DiscoveryError extends Error {}
type Rates = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
export type BifrostModel = Model<"openai-completions"> & { bifrostRates: Rates };

/** Endpoint configuration stays in the deployment environment. Accept the
 * gateway root or its documented OpenAI-compatible suffix; preserve proxy paths. */
export function bifrostRoot(raw: string): string {
	let url: URL;
	try { url = new URL(raw.trim()); } catch { throw new Error("BIFROST_BASE_URL must be a valid HTTP(S) gateway URL."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("BIFROST_BASE_URL must be an HTTP(S) gateway URL without credentials, query, or fragment.");
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:openai(?:\/v1)?|v1)$/, "");
	return url.toString().replace(/\/+$/, "");
}

const object = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const positive = (...values: unknown[]): number => {
	for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	return 0; // Pi uses a nonpositive context limit for unknown; the UI shows "?".
};
function rate(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (value === "") return undefined;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
}

/** Bifrost's native model list preserves the metadata its OpenAI list drops.
 * Prices are per token; Pi uses per-million-token rates. Missing is not free. */
export function bifrostModel(value: unknown, root: string): BifrostModel | undefined {
	const entry = object(value);
	if (typeof entry.id !== "string" || !entry.id.trim() || entry.is_deprecated === true) return undefined;
	const architecture = object(entry.architecture);
	const output = strings(architecture.output_modalities);
	if (output.length && !output.includes("text")) return undefined;
	const methods = strings(entry.supported_methods);
	if (methods.length && !methods.some((method) => /chat|completion|generatecontent|messages/i.test(method))) return undefined;
	const input = strings(architecture.input_modalities).filter((v): v is "text" | "image" => v === "text" || v === "image");
	const pricing = object(entry.pricing);
	const rates: Rates = { input: rate(pricing.prompt), output: rate(pricing.completion), cacheRead: rate(pricing.input_cache_read), cacheWrite: rate(pricing.input_cache_write) };
	const top = object(entry.top_provider);
	const efforts = strings(object(entry.reasoning).supported_efforts);
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of LEVELS) thinkingLevelMap[level] = efforts.includes(level) ? level : level === "off" && efforts.includes("none") ? "none" : null;
	const reasoning = LEVELS.some((level) => level !== "off" && thinkingLevelMap[level] !== null);
	return {
		id: entry.id, name: typeof entry.normalized_name === "string" ? entry.normalized_name : typeof entry.name === "string" ? entry.name : entry.id,
		provider: "bifrost", api: "openai-completions", baseUrl: `${root}/openai`,
		input: input.length ? input : ["text"], reasoning, thinkingLevelMap,
		contextWindow: positive(entry.context_length, top.context_length, entry.max_input_tokens),
		maxTokens: positive(entry.max_output_tokens, top.max_completion_tokens),
		cost: { input: rates.input ?? 0, output: rates.output ?? 0, cacheRead: rates.cacheRead ?? 0, cacheWrite: rates.cacheWrite ?? 0 },
		bifrostRates: rates,
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoning, maxTokensField: "max_completion_tokens" },
	};
}

interface Options {
	env?: () => Record<string, string | undefined>;
	fetch?: typeof fetch;
	now?: () => number;
}

/** One controller is shared across Next route bundles. A key/endpoint change
 * clears the catalog immediately; an old in-flight refresh cannot republish it. */
export function createBifrostAdapter(options: Options = {}) {
	const env = options.env ?? (() => process.env);
	const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
	const now = options.now ?? Date.now;
	let scope = "", generation = 0, loadedAt = -Infinity;
	let models: BifrostModel[] = [], error: string | undefined;
	let pending: Promise<void> | undefined;
	let controller: AbortController | undefined;
	function current() {
		const values = env(), key = values.BIFROST_API_KEY?.trim(), raw = values.BIFROST_BASE_URL?.trim();
		const next = createHash("sha256").update(JSON.stringify([raw, key])).digest("hex");
		if (next !== scope) {
			controller?.abort(); scope = next; generation++; models = []; error = undefined; loadedAt = -Infinity; pending = undefined;
		}
		let root: string | undefined;
		if (key) {
			if (!raw) error = "Set BIFROST_BASE_URL in the server environment to connect Bifrost.";
			else try { root = bifrostRoot(raw); } catch (err) { error = (err as Error).message; }
		}
		return { key, root };
	}
	async function refresh(): Promise<void> {
		const { key, root } = current();
		if (!key || !root) return;
		if (pending) return pending;
		if (now() - loadedAt < (error ? 5_000 : TTL_MS)) return;
		const stamp = generation;
		controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
		const task = Promise.resolve().then(async () => {
			try {
				const found = new Map<string, BifrostModel>();
				let token = "";
				const seen = new Set<string>();
				for (;;) {
					const url = new URL(`${root}/v1/models`);
					if (token) url.searchParams.set("page_token", token);
					const response = await request(url, { headers: { accept: "application/json", "x-bf-vk": key }, signal, redirect: "error" });
					if (!response.ok) throw new DiscoveryError(`Bifrost model discovery failed (HTTP ${response.status}). Check the endpoint and virtual key.`);
					const body = object(await response.json());
					if (!Array.isArray(body.data)) throw new DiscoveryError("Bifrost returned an invalid model list.");
					for (const entry of body.data) { const model = bifrostModel(entry, root); if (model) found.set(model.id, model); }
					token = typeof body.next_page_token === "string" ? body.next_page_token : "";
					if (!token) break;
					if (seen.has(token) || seen.size >= 20) throw new DiscoveryError("Bifrost returned an invalid model pagination sequence.");
					seen.add(token);
				}
				current();
				if (stamp === generation) { models = [...found.values()]; error = undefined; loadedAt = now(); }
			} catch (err) {
				current();
				if (stamp === generation) {
					models = []; loadedAt = now();
					error = err instanceof DiscoveryError ? err.message : "Bifrost model discovery is unavailable. Check gateway connectivity and try again.";
				}
			} finally { if (stamp === generation) pending = undefined; }
		});
		pending = task;
		return task;
	}
	const api = openAICompletionsApi();
	const streams: ProviderStreams = {
		...api,
		streamSimple: (model, context, options) => api.streamSimple(model, context, {
			...options,
			onPayload: async (payload, requestModel) => {
				const replacement = await options?.onPayload?.(payload, requestModel);
				const out = object(replacement === undefined ? payload : replacement);
				// Pi normally derives a response cap from model.maxTokens. If
				// Bifrost did not report one, leave the cap to the gateway.
				if (model.maxTokens <= 0 && options?.maxTokens === undefined) { delete out.max_tokens; delete out.max_completion_tokens; }
				return out;
			},
		}),
	};
	const base = createProvider({
		id: "bifrost", name: "Bifrost", models: [], api: streams,
		auth: { apiKey: { name: "Bifrost virtual key", resolve: async () => {
			const { key, root } = current();
			return key && root ? { auth: { apiKey: key, headers: { "x-bf-vk": key, Authorization: null } } } : undefined;
		} } },
	});
	const provider: Provider = { ...base, getModels: () => { current(); return models; }, getAllModels: () => { current(); return models; } };
	return { provider, refresh, status: () => { current(); return error; } };
}

const SINGLETON = Symbol.for("lh.bifrost.adapter");
export function bifrostAdapter(): ReturnType<typeof createBifrostAdapter> {
	const global = globalThis as typeof globalThis & { [SINGLETON]?: ReturnType<typeof createBifrostAdapter> };
	return global[SINGLETON] ??= createBifrostAdapter();
}
