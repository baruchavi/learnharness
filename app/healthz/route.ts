export const dynamic = "force-dynamic";

/** Liveness: the HTTP process responds, independently of disk/providers. */
export function GET() {
	return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
