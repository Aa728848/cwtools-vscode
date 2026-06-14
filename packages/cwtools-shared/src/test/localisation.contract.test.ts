import { expect } from 'chai';
import { sanitizeLocalisationValue, upsertLocalisationText } from '../safety/localisation';

describe('localisation contract', () => {
  it('creates a UTF-8 BOM file with language header for new localisation files', () => {
    const result = upsertLocalisationText(null, 'l_english', [
      { key: 'test_key', value: 'Hello' },
    ]);

    expect(result.hasBom).to.equal(true);
    expect(result.content.charCodeAt(0)).to.equal(0xfeff);
    expect(result.content).to.include('l_english:\n');
    expect(result.content).to.include(' test_key:0 "Hello"\n');
    expect(result.added).to.equal(1);
    expect(result.updated).to.equal(0);
  });

  it('updates existing keys in place and appends new keys', () => {
    const existing = '\uFEFFl_english:\n old_key:0 "Old"\n';
    const result = upsertLocalisationText(existing, 'l_english', [
      { key: 'old_key', value: 'New' },
      { key: 'added_key', value: 'Added', comment: '# Section' },
    ]);

    expect(result.content.charCodeAt(0)).to.equal(0xfeff);
    expect(result.content).to.include(' old_key:0 "New"');
    expect(result.content).to.include(' # Section\n added_key:0 "Added"');
    expect(result.added).to.equal(1);
    expect(result.updated).to.equal(1);
  });

  it('sanitizes runtime newlines and smart quotes into localisation-safe text', () => {
    expect(sanitizeLocalisationValue('A\r\nB\n“C”\tD')).to.equal(String.raw`A\nB\n"C"\tD`);
  });
});
