/** Run INSIDE a disposable container, never against real learning data.
 * No LLM, credentials, or external requests. The workflow restarts the same
 * container/volume between the initial and --after-restart checks. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

assert.equal(process.env.LH_CONTAINER_SMOKE, "1", "requires an explicitly disposable smoke container");
const origin = `http://127.0.0.1:${process.env.PORT || "3000"}`;
const marker = path.join(process.env.LH_DATA_DIR, ".container-smoke.json");
const require = createRequire(path.join(process.cwd(), "server.js"));

async function json(route, options) {
	const response = await fetch(`${origin}${route}`, { ...options, signal: AbortSignal.timeout(10_000) });
	assert.equal(response.status, 200, `${route}: ${response.status}`);
	return response.json();
}

// Wait for the actual server, not just the container process.
for (let attempt = 0; ; attempt++) {
	try { await json("/readyz"); break; }
	catch (error) {
		if (attempt >= 59) throw error;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
for (const route of ["/healthz", "/readyz", "/api/graph", "/api/models", "/api/settings"]) await json(route);
assert.equal((await fetch(origin)).status, 200);

if (process.argv.includes("--after-restart")) {
	const saved = JSON.parse(await fs.readFile(marker, "utf8"));
	const record = await json(`/api/chats/${saved.id}`);
	assert.equal(record.title, saved.title, "saved session survives restart");
	console.log("[smoke-container] HTTP routes and persisted session survived restart");
} else {
	// A storage outage must remove readiness, never turn a healthy HTTP
	// process into a liveness restart loop. This runs as the non-root user.
	const originalMode = (await fs.stat(process.env.LH_DATA_DIR)).mode & 0o777;
	try {
		await fs.chmod(process.env.LH_DATA_DIR, 0o500);
		assert.equal((await fetch(`${origin}/readyz`)).status, 503);
		assert.equal((await fetch(`${origin}/healthz`)).status, 200);
	} finally { await fs.chmod(process.env.LH_DATA_DIR, originalMode); }
	// Wait for the first heartbeat so the subscription is established before
	// creating the chat. Fetch headers may be held until that first frame.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 40_000);
	try {
		const events = await fetch(`${origin}/api/events`, { signal: controller.signal });
		assert.match(events.headers.get("content-type"), /text\/event-stream/);
		const reader = events.body.getReader();
		await reader.read();
		const chat = await json("/api/chats", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Container persistence check" }),
		});
		let frames = "";
		while (!frames.includes("event: chats-changed")) {
			const { value, done } = await reader.read();
			assert.equal(done, false, "notification stream remains open");
			frames += new TextDecoder().decode(value);
		}
		await reader.cancel();
		await fs.writeFile(marker, JSON.stringify(chat));
	} finally { clearTimeout(timeout); controller.abort(); }

	const { Resvg } = require("@resvg/resvg-js");
	const svg = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><text x="2" y="25">Test</text></svg>');
	assert.ok(svg.render().asPng().length > 100, "native SVG renderer");
	const pdfFile = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
	const pdfjs = await import(pathToFileURL(pdfFile).href);
	const { createCanvas } = createRequire(pdfFile)("@napi-rs/canvas");
	const task = pdfjs.getDocument({
		data: new Uint8Array(await fs.readFile(new URL("./fixtures/sample-3page.pdf", import.meta.url))),
		standardFontDataUrl: path.join(path.dirname(pdfFile), "..", "..", "standard_fonts") + "/",
		verbosity: 0,
	});
	try {
		const pdf = await task.promise;
		const page = await pdf.getPage(1);
		const viewport = page.getViewport({ scale: 1 });
		const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
		await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport }).promise;
		assert.ok(canvas.toBuffer("image/png").length > 100, "native PDF renderer");
	} finally { await task.destroy(); }

	const { default: puppeteer } = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
	const browser = await puppeteer.launch({
		executablePath: process.env.CHROME_PATH, headless: true,
		args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"],
	});
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.setContent('<button onclick="this.textContent=\'done\'">test</button>');
		await page.click("button");
		assert.equal(await page.$eval("button", (element) => element.textContent), "done");
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
	console.log("[smoke-container] HTTP, event streaming, session write, PDF, SVG, Chromium passed");
}
