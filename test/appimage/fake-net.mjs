// Loaded with `node --import` before build.mjs. fetch() answers from files
// instead of the network, and a fake download hashes to the SHA-256 it
// stands in for, so build.mjs checks it as it would the real one.
//
//   FAKE_FETCH  JSON: { url: { status, file } or { status, text } }; any other URL throws
//   FAKE_PINS   JSON: { real SHA-256: SHA-256 to report instead }
//   FAKE_LOG    file each fetch is logged to

import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const answers = JSON.parse(process.env.FAKE_FETCH ?? '{}');
const pins = JSON.parse(process.env.FAKE_PINS ?? '{}');

globalThis.fetch = async (url) => {
  fs.appendFileSync(process.env.FAKE_LOG, `fetch ${url}\n`);
  const answer = answers[url];
  if (!answer) throw new Error(`unexpected fetch of ${url}`);
  const body = answer.file ? fs.readFileSync(answer.file) : Buffer.from(answer.text ?? '');
  return new Response(body, { status: answer.status ?? 200 });
};

const createHash = crypto.createHash;
crypto.createHash = (algorithm, ...rest) => {
  const hash = createHash(algorithm, ...rest);
  const digest = hash.digest.bind(hash);
  hash.digest = (encoding) => {
    const real = digest(encoding);
    return pins[real] ?? real;
  };
  return hash;
};
syncBuiltinESMExports();
