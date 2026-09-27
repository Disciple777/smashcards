#!/usr/bin/env node
/**
 * Static checks for the PHP API, because this machine has no PHP.
 *
 * The host has FTP but no SSH, and there is no local interpreter to run
 * `php -l` against, so until now a mistake in the API only surfaced as an empty
 * 500 from production — with display_errors off, not even a message. This
 * closes that gap for the two failures that actually happen:
 *
 *   1. Syntax errors, via a real PHP parser.
 *   2. Redeclarations — two methods with the same name in one class, or one
 *      class declared in two files. PHP treats these as *compile-time* fatals,
 *      which means they are not catchable, produce a blank 500, and are
 *      invisible to a syntax-only check because the code parses perfectly.
 *
 * It is deliberately not a type checker. It catches the things that take down
 * a whole route, cheaply, before a deploy rather than after one.
 */

import { readFileSync, globSync } from 'node:fs';
import Engine from 'php-parser';

const parser = new Engine({
  parser: { suppressErrors: false, version: 803 },
  ast: { withPositions: true },
});

const problems = [];
/** Class name -> the file that declared it, for cross-file redeclaration. */
const declaredClasses = new Map();

const files = globSync('api/**/*.php').sort();

for (const file of files) {
  let ast;

  try {
    ast = parser.parseCode(readFileSync(file, 'utf8'), file);
  } catch (err) {
    problems.push({ file, line: err.lineNumber ?? 0, message: err.message });
    continue;
  }

  for (const error of ast.errors ?? []) {
    problems.push({ file, line: error.line ?? 0, message: error.message });
  }

  walk(ast, file);
}

function walk(node, file) {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) walk(child, file);
    return;
  }

  if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
    checkClass(node, file);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walk(value, file);
  }
}

function checkClass(node, file) {
  const className = nameOf(node.name);

  if (className) {
    const previous = declaredClasses.get(className);
    if (previous && previous !== file) {
      problems.push({
        file,
        line: node.loc?.start?.line ?? 0,
        message: `class ${className} is also declared in ${previous} — PHP cannot load both`,
      });
    } else {
      declaredClasses.set(className, file);
    }
  }

  const seen = new Map();

  for (const member of node.body ?? []) {
    if (member.kind !== 'method') continue;

    // PHP method names are case-insensitive: store() and STORE() collide.
    const name = nameOf(member.name).toLowerCase();
    if (name === '') continue;

    const first = seen.get(name);
    if (first !== undefined) {
      problems.push({
        file,
        line: member.loc?.start?.line ?? 0,
        message: `cannot redeclare ${className}::${nameOf(member.name)}() `
               + `— already declared on line ${first}`,
      });
    } else {
      seen.set(name, member.loc?.start?.line ?? 0);
    }
  }
}

function nameOf(name) {
  if (typeof name === 'string') return name;
  return typeof name?.name === 'string' ? name.name : '';
}

if (problems.length === 0) {
  console.log(`\nphp lint: ${files.length} files, no problems\n`);
  process.exit(0);
}

console.log('');
for (const { file, line, message } of problems) {
  console.log(`  \x1b[31mFAIL\x1b[0m  ${file}:${line}\n        ${message}`);
}
console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files\n`);
process.exit(1);
