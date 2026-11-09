/** The dock overlays the transcript as a sibling, so native touch scroll
 * chaining cannot reach the lesson. Own vertical pans from their first move
 * (Safari cannot reliably cancel a pan after native scrolling has started),
 * consuming inner scrollers before forwarding the remainder to the lesson.
 * Taps, horizontal pans, text selection, and multi-touch stay native. */
export function attachDockTouchScroll(
	root: HTMLElement,
	transcript: HTMLElement,
	beforeTranscriptScroll: (deltaY: number) => void,
): () => void {
	type Pan = { id: number; x: number; y: number; vertical: boolean };
	let pan: Pan | null = null;
	const view = root.ownerDocument.defaultView;

	const reset = () => { pan = null; };
	const onStart = (event: TouchEvent) => {
		const touch = event.touches.length === 1 ? event.touches[0] : undefined;
		if (!touch || root.ownerDocument.getSelection()?.isCollapsed === false) {
			reset();
			return;
		}
		pan = { id: touch.identifier, x: touch.clientX, y: touch.clientY, vertical: false };
	};
	const onMove = (event: TouchEvent) => {
		const touch = event.touches.length === 1 ? event.touches[0] : undefined;
		if (!pan || !touch || touch.identifier !== pan.id || !event.cancelable
			|| root.ownerDocument.getSelection()?.isCollapsed === false) {
			reset();
			return;
		}
		const deltaY = pan.y - touch.clientY;
		const deltaX = pan.x - touch.clientX;
		if (!pan.vertical) {
			if (deltaY === 0 && deltaX === 0) return;
			if (Math.abs(deltaX) >= Math.abs(deltaY)) {
				reset(); // preserve horizontal code scrolling and browser gestures
				return;
			}
			pan.vertical = true;
		}
		pan.x = touch.clientX;
		pan.y = touch.clientY;
		event.preventDefault();
		let remaining = deltaY;
		const target = event.target as Node | null;
		let node = target?.nodeType === 1 ? target as HTMLElement : target?.parentElement;
		for (; node && root.contains(node); node = node.parentElement) {
			const max = node.scrollHeight - node.clientHeight;
			if (max > 0 && /^(auto|scroll|overlay)$/.test(view?.getComputedStyle(node).overflowY ?? "")) {
				const top = Math.max(0, Math.min(max, node.scrollTop));
				const next = Math.max(0, Math.min(max, top + remaining));
				node.scrollTop = next;
				remaining -= next - top;
				if (Math.abs(remaining) < 0.5) return;
			}
			if (node === root) break;
		}
		if (remaining !== 0) {
			beforeTranscriptScroll(remaining);
			transcript.scrollTop = Math.max(0, Math.min(
				transcript.scrollHeight - transcript.clientHeight,
				transcript.scrollTop + remaining,
			));
		}
	};
	root.addEventListener("touchstart", onStart, { passive: true });
	root.addEventListener("touchmove", onMove, { passive: false });
	root.addEventListener("touchend", reset, { passive: true });
	root.addEventListener("touchcancel", reset, { passive: true });
	return () => {
		root.removeEventListener("touchstart", onStart);
		root.removeEventListener("touchmove", onMove);
		root.removeEventListener("touchend", reset);
		root.removeEventListener("touchcancel", reset);
	};
}
