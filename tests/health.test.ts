import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { storageReady } from "../src/server/health.ts";

it("storage readiness accepts first boot without credentials and existing credentials", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "lh-health-"));
	try {
		const data = path.join(root, "data");
		const auth = path.join(root, "auth.json");
		mkdirSync(data);
		assert.equal(storageReady(data, auth), true);
		writeFileSync(auth, "{}\n", { mode: 0o600 });
		assert.equal(storageReady(data, auth), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("storage readiness refuses absent or invalid persistence paths", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "lh-health-"));
	try {
		const file = path.join(root, "file");
		writeFileSync(file, "not a directory");
		assert.equal(storageReady(path.join(root, "missing"), path.join(root, "auth.json")), false);
		assert.equal(storageReady(file, path.join(root, "auth.json")), false);
		assert.equal(storageReady(root, path.join(root, "missing", "auth.json")), false);
		assert.equal(storageReady(root, root), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
