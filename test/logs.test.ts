// Marker protocol, text sanitizing and tailing: the log layer is pure parsing,
// so it is tested directly.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	findExitMarker,
	LIMIT_MARKER,
	sanitizeText,
	stripMarkers,
	tailLines,
	wholeCharacters,
} from "../src/logs.ts";

const NONCE = "abc123";

test("findExitMarker finds the marker line and its code", () => {
	const marker = findExitMarker(`output\n__BG_EXIT__:${NONCE}:0\n`, NONCE);
	assert.ok(marker !== undefined);
	assert.equal(marker.code, 0);
	assert.equal(marker.start, "output\n".length);
	assert.equal(marker.end, "output\n__BG_EXIT__:abc123:0\n".length);
});

test("findExitMarker accepts a marker at the chunk start and at the end of file", () => {
	const atStart = findExitMarker(`__BG_EXIT__:${NONCE}:7\n`, NONCE);
	assert.ok(atStart !== undefined);
	assert.equal(atStart.code, 7);
	assert.equal(atStart.start, 0);
	const atEnd = findExitMarker(`out\n__BG_EXIT__:${NONCE}:3`, NONCE);
	assert.ok(atEnd !== undefined);
	assert.equal(atEnd.code, 3);
});

test("findExitMarker reads negative and multi-digit codes and tolerates CRLF", () => {
	assert.equal(findExitMarker(`\r\n__BG_EXIT__:${NONCE}:-1\r\n`, NONCE)?.code, -1);
	assert.equal(findExitMarker(`\n__BG_EXIT__:${NONCE}:256\n`, NONCE)?.code, 256);
});

test("findExitMarker ignores another task's marker and output that looks like one", () => {
	assert.equal(findExitMarker("\n__BG_EXIT__:othernonce:0\n", NONCE), undefined);
	assert.equal(findExitMarker(`__BG_EXIT__:${NONCE}:0 extra text\n`, NONCE), undefined);
	assert.equal(findExitMarker(`\n__BG_GONE__:${NONCE}\n`, NONCE), undefined);
});

test("stripMarkers cuts every protocol line and keeps the output", () => {
	const text = `a\n__BG_EXIT__:${NONCE}:0\nb\n__BG_GONE__:${NONCE}\nc\n${LIMIT_MARKER}\n`;
	assert.equal(stripMarkers(text, NONCE), "a\nb\nc\n");
	assert.equal(stripMarkers("plain output\n", NONCE), "plain output\n");
});

test("sanitizeText strips ANSI escapes and control characters", () => {
	assert.equal(sanitizeText("\x1b[31mred\x1b[0m\n"), "red\n");
	assert.equal(sanitizeText("bell\x07 and\x00 tab\tkept"), "bell and tab\tkept");
	assert.equal(sanitizeText("\x1b]0;title\x07after"), "after");
});

test("wholeCharacters keeps buffers off character boundaries", () => {
	const buffer = Buffer.from("héllo", "utf8");
	const cut = buffer.subarray(0, buffer.length - 1);
	assert.equal(wholeCharacters(cut).toString("utf8"), "héll");
	const lead = buffer.subarray(2); // starts on a continuation byte
	assert.equal(wholeCharacters(lead).toString("utf8"), "llo");
});

test("tailLines caps lines and bytes and says when it cut", () => {
	const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	const tail = tailLines(text, 5, 4096);
	assert.equal(tail.cut, true);
	assert.ok(tail.text.endsWith("line 29"));
	assert.equal(tail.text.split("\n").length, 5);
	const byteCut = tailLines("x".repeat(100), 5, 10);
	assert.equal(byteCut.cut, true);
	assert.equal(Buffer.byteLength(byteCut.text, "utf8"), 10);
});
