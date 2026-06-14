import { expect } from 'chai';
import * as path from 'path';
import { resolveWorkspacePath, validateLocalisationPath } from '../safety/paths';

describe('path safety contract', () => {
  const workspaceRoot = path.resolve(process.cwd(), '.tmp-contract-workspace');

  it('rejects parent traversal outside the workspace', () => {
    const result = resolveWorkspacePath(workspaceRoot, '../outside.yml');
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('outside_workspace');
  });

  it('rejects absolute paths outside the workspace', () => {
    const outside = path.resolve(path.parse(workspaceRoot).root, 'outside.yml');
    const result = resolveWorkspacePath(workspaceRoot, outside);
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('outside_workspace');
  });

  it('allows real localisation YML paths under accepted localisation roots', () => {
    const result = validateLocalisationPath(workspaceRoot, 'localisation/english/test_l_english.yml');
    expect(result.ok).to.equal(true);
    expect(result.relativePath).to.equal('localisation/english/test_l_english.yml');
  });

  it('rejects non-YML and non-localisation paths', () => {
    expect(validateLocalisationPath(workspaceRoot, 'localisation/english/test.txt').reason).to.equal('not_yml');
    expect(validateLocalisationPath(workspaceRoot, 'common/test_l_english.yml').reason).to.equal('not_localisation_directory');
  });

  it('rejects .cwtools-ai scratch localisation writes', () => {
    const result = validateLocalisationPath(workspaceRoot, '.cwtools-ai/topic/scratch/bad_l_english.yml');
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('scratch_path');
  });
});
