import { flattenForPicker } from '../services/folderTree.js';

/**
 * A destination picker for moving a deck or a folder: root plus every folder
 * in a depth-first, indented order. `excludeSubtreeOf` is set when moving a
 * folder itself, so it can't be offered as its own destination or dropped
 * into one of its own children — the same rule the server enforces, applied
 * here only so the UI doesn't offer a move it knows will be rejected.
 */
export default function FolderPicker({ folders, value, excludeSubtreeOf = null, onChange, disabled = false }) {
  const options = flattenForPicker(folders, { excludeSubtreeOf });

  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">No folder (root)</option>
      {options.map((folder) => (
        <option key={folder.id} value={folder.id}>
          {'  '.repeat(folder.depth)}
          {folder.depth > 0 ? '└ ' : ''}
          {folder.name}
        </option>
      ))}
    </select>
  );
}
