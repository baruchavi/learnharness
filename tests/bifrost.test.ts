import assert from "node:assert/strict";
import { it } from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { bifrostAdapter, bifrostModel, bifrostRoot, createBifrostAdapter } from "../src/agent/bifrost.ts";
import { MODEL_PROVIDER_KEYS, isProviderEnvVar } from "../src/core/auth-keys.ts";
import { catalogContextLimits, modelCatalog, refreshConnectionCatalog, validateModelsSettings } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";
import { piEngineForSpec } from "../src/agent/models.ts";

const metadata = {
	id: "anthropic/claude-sonnet-4-5", normalized_name: "Claude Sonnet 4.5",
	context_length: 200_000, max_output_tokens: 32_000,
	architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
	pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
	reasoning: { supported_efforts: ["none", "low", "high"] },
};
const baseEnv = () => ({ BIFROST_BASE_URL: "http://bifrost.bifrost.svc.cluster.local:8080/openai", BIFROST_API_KEY: "fixture-virtual-key" });

it("accepts external/internal gateway roots and documented API suffixes without storing URL settings", () => {
	for (const suffix of ["", "/", "/openai", "/openai/v1/", "/v1"])
		assert.equal(bifrostRoot(`http://bifrost.bifrost.svc.cluster.local:8080${suffix}`), "http://bifrost.bifrost.svc.cluster.local:8080");
	assert.equal(bifrostRoot("https://gateway.example.invalid/prefix/openai"), "https://gateway.example.invalid/prefix");
	for (const value of ["not a url", "file:///tmp/key", "https://user:secret@example.invalid", "https://example.invalid/?key=secret", "https://example.invalid/#token"])
		assert.throws(() => bifrostRoot(value), /BIFROST_BASE_URL/);
	assert.ok(MODEL_PROVIDER_KEYS.some((p) => p.id === "bifrost" && p.envVar === "BIFROST_API_KEY"));
	assert.equal(isProviderEnvVar("BIFROST_API_KEY"), true);
	assert.equal(isProviderEnvVar("BIFROST_BASE_URL"), false);
});

it("uses reported model metadata, converts per-token pricing, and excludes non-chat/deprecated models", () => {
	const model = bifrostModel(metadata, "https://gateway.example.invalid")!;
	assert.equal(model.id, metadata.id);
	assert.equal(model.provider, "bifrost");
	assert.equal(model.baseUrl, "https://gateway.example.invalid/openai");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 32_000);
	assert.equal(model.cost.input, 3);
	assert.equal(model.cost.output, 15);
	assert.equal(model.cost.cacheRead, 0.3);
	assert.equal(model.bifrostRates.cacheWrite, undefined);
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "high"]);
	const unknown = bifrostModel({ id: "custom/my-model" }, "https://gateway.example.invalid")!;
	assert.equal(unknown.contextWindow, 0);
	assert.equal(unknown.maxTokens, 0);
	assert.equal(unknown.bifrostRates.input, undefined);
	assert.deepEqual(getSupportedThinkingLevels(unknown), ["off"]);
	assert.equal(bifrostModel({ ...metadata, is_deprecated: true }, "http://localhost"), undefined);
	assert.equal(bifrostModel({ ...metadata, architecture: { output_modalities: ["image"] } }, "http://localhost"), undefined);
	assert.equal(bifrostModel({ ...metadata, supported_methods: ["embeddings"] }, "http://localhost"), undefined);
	assert.equal(bifrostModel({ ...metadata, supported_methods: ["responses"] }, "http://localhost"), undefined);
});

it("discovers key-scoped native models with pagination, deduplicates concurrent refreshes and caches successful results", async () => {
	let time = 0;
	const seen: string[] = [];
	const adapter = createBifrostAdapter({ env: baseEnv, now: () => time, fetch: async (input, init) => {
		const url = new URL(String(input)); seen.push(url.href);
		assert.equal(new Headers(init?.headers).get("x-bf-vk"), "fixture-virtual-key");
		assert.equal(init?.redirect, "error");
		assert.equal(init?.signal?.aborted, false);
		return Response.json(url.searchParams.has("page_token") ? { data: [{ id: "custom/second" }] } : { data: [metadata], next_page_token: "page-two" });
	} });
	await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh()]);
	assert.deepEqual(seen, ["http://bifrost.bifrost.svc.cluster.local:8080/v1/models", "http://bifrost.bifrost.svc.cluster.local:8080/v1/models?page_token=page-two"]);
	assert.deepEqual(adapter.provider.getModels().map((m) => m.id), [metadata.id, "custom/second"]);
	await adapter.refresh(); assert.equal(seen.length, 2);
	time = 60_001;
	await adapter.refresh(); assert.equal(seen.length, 4);
});

it("never reuses a previous key's model list or lets its late response overwrite the rotated key", async () => {
	const env = baseEnv();
	let finish!: (response: Response) => void;
	const first = new Promise<Response>((resolve) => { finish = resolve; });
	const adapter = createBifrostAdapter({ env: () => env, fetch: async (_url, init) =>
		new Headers(init?.headers).get("x-bf-vk") === "fixture-virtual-key" ? first : Response.json({ data: [{ id: "new-key/model" }] }) });
	const old = adapter.refresh();
	await Promise.resolve();
	env.BIFROST_API_KEY = "rotated-virtual-key";
	assert.deepEqual(adapter.provider.getModels(), []);
	await adapter.refresh();
	finish(Response.json({ data: [metadata] }));
	await old;
	assert.deepEqual(adapter.provider.getModels().map((m) => m.id), ["new-key/model"]);
	env.BIFROST_API_KEY = "";
	assert.deepEqual(adapter.provider.getModels(), []);
});

it("reports discovery/config failures without exposing keys and retries synchronous network failures", async () => {
	let time = 0, calls = 0;
	const adapter = createBifrostAdapter({ env: baseEnv, now: () => time, fetch: () => { calls++; throw new Error("request failed: fixture-virtual-key"); } });
	await adapter.refresh();
	assert.match(adapter.status()!, /unavailable/);
	assert.ok(!adapter.status()!.includes("fixture-virtual-key"));
	time = 5_001;
	await adapter.refresh(); assert.equal(calls, 2);
	const denied = createBifrostAdapter({ env: baseEnv, fetch: async () => new Response("fixture-virtual-key", { status: 401 }) });
	await denied.refresh();
	assert.match(denied.status()!, /HTTP 401/);
	assert.ok(!denied.status()!.includes("fixture-virtual-key"));
	const missing = createBifrostAdapter({ env: () => ({ BIFROST_API_KEY: "fixture-virtual-key" }), fetch: async () => { throw new Error("must not fetch"); } });
	await missing.refresh(); assert.match(missing.status()!, /BIFROST_BASE_URL/);
});

it("streams a real OpenAI-compatible tool call through Bifrost with the saved virtual key and no invented token cap", async () => {
	const adapter = createBifrostAdapter({ env: baseEnv, fetch: async () => Response.json({ data: [{ id: "custom/my-model" }] }) });
	await adapter.refresh();
	const models = createModels(); models.setProvider(adapter.provider);
	let wire: Record<string, unknown> | undefined;
	const stream = models.streamSimple(models.getModel("bifrost", "custom/my-model")!, {
		messages: [{ role: "user", content: "Ask a question", timestamp: Date.now() }],
		tools: [{ name: "quiz", description: "Ask a question", parameters: { type: "object", properties: {} } }],
	}, { fetch: async (input, init) => {
		assert.equal(String(input), "http://bifrost.bifrost.svc.cluster.local:8080/openai/chat/completions");
		assert.equal(new Headers(init?.headers).get("x-bf-vk"), "fixture-virtual-key");
		assert.equal(new Headers(init?.headers).get("authorization"), null);
		wire = JSON.parse(String(init?.body));
		const frames = [
			{ id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "quiz", arguments: "{}" } }] }, finish_reason: null }] },
			{ id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
		];
		return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	} });
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.equal(result.provider, "bifrost");
	assert.equal(result.content[0]?.type, "toolCall");
	assert.equal(result.usage.input, 10);
	assert.equal(wire?.model, "custom/my-model");
	assert.equal(wire?.max_tokens, undefined);
	assert.equal(wire?.max_completion_tokens, undefined);
});

it("warms the application catalog after restart, validates slot choices, and keeps unknown costs honest", async (t) => {
	const oldEnv = { BIFROST_BASE_URL: process.env.BIFROST_BASE_URL, BIFROST_API_KEY: process.env.BIFROST_API_KEY };
	const oldFetch = globalThis.fetch;
	t.after(() => {
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		globalThis.fetch = oldFetch;
		bifrostAdapter().provider.getModels();
	});
	Object.assign(process.env, baseEnv());
	globalThis.fetch = async () => Response.json({ data: [metadata, { id: "custom/unknown" }] });
	await refreshConnectionCatalog("bifrost");
	const catalog = modelCatalog();
	assert.ok(catalog.providers.some((p) => p.id === "bifrost" && p.keyPresent));
	assert.equal(catalog.models.find((m) => m.id === metadata.id && m.provider === "bifrost")?.cost.input, 3);
	assert.equal(catalog.models.find((m) => m.id === "custom/unknown")?.costKnown, false);
	assert.equal(catalogContextLimits().get(`bifrost:${metadata.id}`), 200_000);
	assert.equal(catalogContextLimits().has("bifrost:custom/unknown"), false);
	assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "bifrost", id: metadata.id } } }), { ok: true });
	assert.ok(piEngineForSpec({ provider: "bifrost", id: metadata.id }));
	assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, `bifrost:${metadata.id}`), 18);
	assert.equal(callCost({ inputTokens: 1, outputTokens: 1 }, "bifrost:custom/unknown"), null);
	assert.equal(callCost({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 5 }, `bifrost:${metadata.id}`), null);
	process.env.BIFROST_API_KEY = "different-key";
	globalThis.fetch = async () => new Response("private gateway details", { status: 403 });
	await refreshConnectionCatalog("bifrost");
	const failed = modelCatalog();
	assert.equal(failed.models.some((m) => m.provider === "bifrost"), false);
	assert.match(failed.providerErrors?.bifrost ?? "", /HTTP 403/);
	assert.ok(!failed.providerErrors?.bifrost?.includes("private gateway details"));
});
