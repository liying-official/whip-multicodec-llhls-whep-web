"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appPath = path.join(__dirname, "..", "web", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const begin = source.indexOf("// BEGIN R33 WHEP OPUS STEREO");
const end = source.indexOf("// END R33 WHEP OPUS STEREO");
assert(begin >= 0 && end > begin, "production SDP helper markers not found");
const helperSource = source.slice(begin, end);
const context = {};
vm.createContext(context);
vm.runInContext(`${helperSource}\nthis.fix = ensureOpusStereoFmtp;`, context);
const fix = context.fix;
assert.strictEqual(typeof fix, "function");

const base = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  ""
].join("\r\n");

const offer = fix(base, false);
assert(offer.includes("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1\r\n"));
assert(!offer.includes("sprop-stereo=1"));

const answer = fix(base, true);
assert(answer.includes("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n"));

const replaceZero = fix(base.replace("useinbandfec=1", "stereo=0;sprop-stereo=0;useinbandfec=1"), true);
assert(replaceZero.includes("stereo=1"));
assert(replaceZero.includes("sprop-stereo=1"));
assert(replaceZero.includes("useinbandfec=1"));
assert(!replaceZero.includes("stereo=0"));

const noFmtp = fix([
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 109",
  "a=rtpmap:109 opus/48000/2",
  "a=sendonly"
].join("\n"), true);
assert(noFmtp.includes("a=rtpmap:109 opus/48000/2\na=fmtp:109 stereo=1;sprop-stereo=1\n"));

const nonOpus = "v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n";
assert.strictEqual(fix(nonOpus, true), nonOpus);

const idempotent = fix(answer, true);
assert.strictEqual(idempotent, answer);
assert.strictEqual((idempotent.match(/stereo=1/g) || []).length, 2);

console.log("R33 WHEP Opus stereo SDP regression tests: PASS");
