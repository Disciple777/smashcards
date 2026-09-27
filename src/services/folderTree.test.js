import test from 'node:test';
import assert from 'node:assert/strict';

import {
  breadcrumbPath,
  childFolders,
  decksInFolder,
  decksInFolderRecursive,
  flattenForPicker,
  isSelfOrDescendant,
} from './folderTree.js';

const folder = (id, name, parentId = null) => ({ id, name, parent_id: parentId });
const deck = (id, title, folderId = null) => ({ id, title, folder_id: folderId });

// root(1)
//   Languages(2)
//     Spanish(3)
//       Verbs(4)
//   Science(5)
const TREE = [
  folder(2, 'Languages'),
  folder(3, 'Spanish', 2),
  folder(4, 'Verbs', 3),
  folder(5, 'Science'),
];

test('childFolders returns only direct children, alphabetically', () => {
  const roots = childFolders(TREE, null);
  assert.deepEqual(roots.map((f) => f.name), ['Languages', 'Science']);

  const underLanguages = childFolders(TREE, 2);
  assert.deepEqual(underLanguages.map((f) => f.name), ['Spanish']);
});

test('childFolders on an empty or missing list does not throw', () => {
  assert.deepEqual(childFolders(null, null), []);
  assert.deepEqual(childFolders(undefined, 1), []);
});

test('decksInFolder matches by folder_id, treating undefined as root', () => {
  const decks = [deck(1, 'A', 2), deck(2, 'B', null), deck(3, 'C')];
  assert.deepEqual(decksInFolder(decks, 2).map((d) => d.id), [1]);
  assert.deepEqual(decksInFolder(decks, null).map((d) => d.id).sort(), [2, 3]);
});

test('decksInFolder sorts by title', () => {
  const decks = [deck(1, 'Zebra', null), deck(2, 'Apple', null)];
  assert.deepEqual(decksInFolder(decks, null).map((d) => d.title), ['Apple', 'Zebra']);
});

test('breadcrumbPath walks from the root down to the target, inclusive', () => {
  const path = breadcrumbPath(TREE, 4);
  assert.deepEqual(path.map((f) => f.name), ['Languages', 'Spanish', 'Verbs']);
});

test('breadcrumbPath at a root-level folder is just that folder', () => {
  const path = breadcrumbPath(TREE, 5);
  assert.deepEqual(path.map((f) => f.name), ['Science']);
});

test('breadcrumbPath at the actual root is empty', () => {
  assert.deepEqual(breadcrumbPath(TREE, null), []);
});

test('breadcrumbPath on a deleted-out-from-under-you folder id stops cleanly', () => {
  assert.deepEqual(breadcrumbPath(TREE, 999), []);
});

test('isSelfOrDescendant is true for the folder itself', () => {
  assert.equal(isSelfOrDescendant(TREE, 2, 2), true);
});

test('isSelfOrDescendant is true for anything in the subtree', () => {
  assert.equal(isSelfOrDescendant(TREE, 4, 2), true); // Verbs is under Languages
  assert.equal(isSelfOrDescendant(TREE, 3, 2), true); // Spanish is under Languages
});

test('isSelfOrDescendant is false for an unrelated folder', () => {
  assert.equal(isSelfOrDescendant(TREE, 5, 2), false); // Science is not under Languages
  assert.equal(isSelfOrDescendant(TREE, 2, 4), false); // Languages is not under Verbs — wrong direction
});

test('isSelfOrDescendant does not infinite-loop on corrupted parent data', () => {
  const corrupt = [folder(1, 'A', 2), folder(2, 'B', 1)]; // 1 -> 2 -> 1
  assert.doesNotThrow(() => isSelfOrDescendant(corrupt, 1, 99));
});

test('decksInFolderRecursive includes decks in nested subfolders', () => {
  const decks = [deck(1, 'in Languages', 2), deck(2, 'in Spanish', 3), deck(3, 'in Verbs', 4), deck(4, 'in Science', 5)];
  const result = decksInFolderRecursive(TREE, decks, 2);
  assert.deepEqual(result.map((d) => d.id).sort(), [1, 2, 3]);
});

test('decksInFolderRecursive at a leaf folder returns only its own decks', () => {
  const decks = [deck(1, 'in Verbs', 4)];
  assert.deepEqual(decksInFolderRecursive(TREE, decks, 4).map((d) => d.id), [1]);
});

test('flattenForPicker produces a depth-first indented order', () => {
  const flat = flattenForPicker(TREE);
  assert.deepEqual(flat, [
    { id: 2, name: 'Languages', depth: 0 },
    { id: 3, name: 'Spanish', depth: 1 },
    { id: 4, name: 'Verbs', depth: 2 },
    { id: 5, name: 'Science', depth: 0 },
  ]);
});

test('flattenForPicker excludes a folder and its whole subtree', () => {
  const flat = flattenForPicker(TREE, { excludeSubtreeOf: 2 });
  assert.deepEqual(flat.map((f) => f.id), [5]); // Languages, Spanish, Verbs all gone; Science remains
});

test('flattenForPicker with no exclusion and an empty tree returns an empty list', () => {
  assert.deepEqual(flattenForPicker([]), []);
  assert.deepEqual(flattenForPicker(null), []);
});
