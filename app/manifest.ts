import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Learning Harness",
		short_name: "Learning Harness",
		description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
		id: "/",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		],
	};
}
