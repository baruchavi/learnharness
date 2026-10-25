import { storageReady } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	const ready = storageReady();
	return Response.json(
		{ status: ready ? "ready" : "unavailable" },
		{ status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
	);
}
