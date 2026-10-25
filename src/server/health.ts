import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";

/** Readiness checks local persistence only. Model setup and external
 * providers must never determine pod health or cause restart loops. */
export function storageReady(dataDir = PATHS.data, authFile = AUTH_FILE): boolean {
	try {
		for (const dir of new Set([dataDir, path.dirname(authFile)])) {
			if (!statSync(dir).isDirectory()) return false;
			accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
		}
		// First boot needs no key file. Existing credentials must be readable;
		// updates use an atomic rename in the parent directory.
		if (existsSync(authFile)) {
			if (!statSync(authFile).isFile()) return false;
			accessSync(authFile, constants.R_OK);
		}
		return true;
	} catch {
		return false;
	}
}
