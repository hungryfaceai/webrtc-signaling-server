#!/usr/bin/env node
// hash-password.js — turn your admin password into the hash Render stores.
//
//   node hash-password.js
//
// Run it on your own computer. It asks for the password twice (nothing is shown as you type),
// prints a line like  scrypt$131072$8$1$…$…  and exits. Copy that whole line into the Render
// environment variable ADMIN_PASSWORD_HASH. The password itself is not stored anywhere.
import { hashPassword } from './admin-auth.js';

function ask(question) {
  return new Promise((resolve) => {
    // Prompts go to stderr, so stdout carries ONLY the hash (clean to copy or redirect).
    const { stdin } = process,
      stdout = process.stderr;
    stdout.write(question);
    if (!stdin.isTTY) {
      // piped input (e.g. tests): read one line
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => {
        data += c;
        if (data.includes('\n')) {
          stdin.pause();
          resolve(data.split('\n')[0].replace(/\r$/, ''));
        }
      });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdout.write('\n');
        process.exit(130);
      } // Ctrl+C
      else if (ch === '\u007f' || ch === '\b')
        value = value.slice(0, -1); // Backspace
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

const pw1 = await ask('New admin password (at least 12 characters): ');
if (pw1.length < 12) {
  console.error('Too short: use at least 12 characters (a passphrase of 4+ words is ideal).');
  process.exit(1);
}
const pw2 = process.stdin.isTTY ? await ask('Type it again: ') : pw1;
if (pw1 !== pw2) {
  console.error('The two passwords do not match.');
  process.exit(1);
}
console.error('\nHashing (takes a moment)…');
const hash = await hashPassword(pw1);
console.log(hash); // the ONLY thing written to stdout
console.error('\nCopy the line starting with scrypt$ into Render → your service → Environment → ADMIN_PASSWORD_HASH.');
