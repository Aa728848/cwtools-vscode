import { strict as assert } from 'assert';
import * as path from 'path';
import { isLspWatchedFile, pathToFileUri } from '../hosts/lspProcessHost';

describe('standalone LSP file watcher contract', () => {
  const root = path.resolve('C:/workspace/mod');

  it('accepts Paradox semantic files inside the workspace', () => {
    assert.equal(isLspWatchedFile(root, path.join(root, 'events', 'example.txt')), true);
    assert.equal(isLspWatchedFile(root, path.join(root, '..templates', 'example.txt')), true);
    assert.equal(isLspWatchedFile(root, path.join(root, 'localisation', 'example.yml')), true);
    assert.equal(isLspWatchedFile(root, path.join(root, 'localisation', 'example.csv')), true);
    assert.equal(isLspWatchedFile(root, path.join(root, 'localisation', 'example.csv'), 'ck2'), true);
    assert.equal(isLspWatchedFile(root, path.join(root, 'localisation', 'example.csv'), 'stellaris'), false);
    assert.equal(isLspWatchedFile(root, path.join(root, 'interface', 'example.gui')), true);
  });

  it('ignores generated/private directories, unsupported files, and paths outside the workspace', () => {
    assert.equal(isLspWatchedFile(root, path.join(root, '.cwtools-ai', 'topic', 'scratch.txt')), false);
    assert.equal(isLspWatchedFile(root, path.join(root, '.git', 'config')), false);
    assert.equal(isLspWatchedFile(root, path.join(root, 'notes.md')), false);
    assert.equal(isLspWatchedFile(root, path.resolve(root, '..', 'other', 'events.txt')), false);
  });

  it('encodes file paths as LSP file URIs', () => {
    const uri = pathToFileUri(path.join(root, 'events', 'a # b.txt'));
    assert.match(uri, /^file:\/\//);
    assert.equal(uri.includes('%23'), true);
  });
});
