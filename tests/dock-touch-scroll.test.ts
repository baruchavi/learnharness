import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { attachDockTouchScroll } from "../components/dock-touch-scroll.ts";

function fixture() {
	const { document, window } = parseHTML("<html><body><div id='lesson'></div><div id='dock'><div id='question'><textarea></textarea></div></div></body></html>");
	Object.assign(window, { getComputedStyle: (node: HTMLElement) => ({ overflowY: node.style.overflowY || "visible" }) });
	Object.assign(document, { getSelection: () => ({ isCollapsed: true }) });
	const lesson = document.getElementById("lesson")!;
	const dock = document.getElementById("dock")!;
	const question = document.getElementById("question")!;
	const answer = document.querySelector("textarea")!;
	const geometry = (node: HTMLElement, height: number, content: number, top = 0) => {
		Object.defineProperties(node, {
			clientHeight: { configurable: true, value: height },
			scrollHeight: { configurable: true, value: content },
			scrollTop: { configurable: true, writable: true, value: top },
		});
		node.style.overflowY = "auto";
	};
	geometry(lesson, 400, 1600, 1200);
	geometry(dock, 300, 300);
	geometry(question, 200, 200);
	geometry(answer, 60, 60);
	answer.value = "unfinished answer";
	const forwarded: number[] = [];
	const detach = attachDockTouchScroll(dock, lesson, (dy) => forwarded.push(dy));
	const point = (y: number, x = 100, identifier = 1) => ({ clientY: y, clientX: x, identifier });
	const event = (type: string, points: ReturnType<typeof point>[], target: HTMLElement = answer, cancelable = true) => {
		const e = new window.Event(type, { bubbles: true, cancelable });
		Object.assign(e, { touches: points });
		target.dispatchEvent(e);
		return e;
	};
	return { document, lesson, dock, question, answer, geometry, forwarded, detach, point, event };
}

describe("dock touch scrolling", () => {
	it("a downward finger swipe over an open question scrolls back to teaching and preserves the answer", () => {
		const f = fixture();
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(220)]).defaultPrevented, true);
		assert.equal(f.lesson.scrollTop, 1080);
		assert.deepEqual(f.forwarded, [-120], "release bottom-follow before moving the transcript");
		assert.equal(f.answer.value, "unfinished answer");
		f.detach();
	});

	it("scrolls a long question first, then hands the remainder to the transcript in the same pan", () => {
		const f = fixture();
		f.geometry(f.question, 200, 600, 60);
		f.event("touchstart", [f.point(100)]);
		f.event("touchmove", [f.point(140)]);
		assert.equal(f.question.scrollTop, 20);
		assert.equal(f.lesson.scrollTop, 1200);
		f.event("touchmove", [f.point(200)]);
		assert.equal(f.question.scrollTop, 0);
		assert.equal(f.lesson.scrollTop, 1160);
		assert.deepEqual(f.forwarded, [-40]);
		f.detach();
	});

	it("consumes nested answer and outer dock scrolling before the transcript", () => {
		const f = fixture();
		f.geometry(f.answer, 60, 180, 10);
		f.geometry(f.dock, 300, 500, 20);
		f.event("touchstart", [f.point(100)]);
		f.event("touchmove", [f.point(150)]);
		assert.equal(f.answer.scrollTop, 0);
		assert.equal(f.dock.scrollTop, 0);
		assert.equal(f.lesson.scrollTop, 1180);
		assert.deepEqual(f.forwarded, [-20]);
		f.detach();
	});

	it("can scroll down to the question again, clamping at the transcript bottom", () => {
		const f = fixture();
		f.lesson.scrollTop = 1100;
		f.geometry(f.question, 200, 600, 390);
		f.event("touchstart", [f.point(300)]);
		f.event("touchmove", [f.point(150)]);
		assert.equal(f.question.scrollTop, 400);
		assert.equal(f.lesson.scrollTop, 1200);
		assert.deepEqual(f.forwarded, [140]);
		f.detach();
	});

	it("leaves taps, horizontal gestures, and multi-touch native", () => {
		const f = fixture();
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchend", []).defaultPrevented, false);
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(105, 150)]).defaultPrevented, false);
		assert.equal(f.event("touchmove", [f.point(200, 150)]).defaultPrevented, false);
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(200), f.point(200, 200, 2)]).defaultPrevented, false);
		assert.equal(f.event("touchmove", [f.point(250)]).defaultPrevented, false);
		assert.equal(f.lesson.scrollTop, 1200);
		assert.deepEqual(f.forwarded, []);
		f.detach();
	});

	it("leaves text selection and noncancelable gestures native", () => {
		const f = fixture();
		Object.assign(f.document, { getSelection: () => ({ isCollapsed: false }) });
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(200)]).defaultPrevented, false);
		Object.assign(f.document, { getSelection: () => ({ isCollapsed: true }) });
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(200)], f.answer, false).defaultPrevented, false);
		assert.equal(f.lesson.scrollTop, 1200);
		f.detach();
	});

	it("cancels ended gestures and removes all listeners on unmount", () => {
		const f = fixture();
		for (const end of ["touchend", "touchcancel"]) {
			f.event("touchstart", [f.point(100)]);
			f.event(end, []);
			assert.equal(f.event("touchmove", [f.point(200)]).defaultPrevented, false);
		}
		f.detach();
		f.event("touchstart", [f.point(100)]);
		assert.equal(f.event("touchmove", [f.point(200)]).defaultPrevented, false);
		assert.equal(f.lesson.scrollTop, 1200);
	});
});
