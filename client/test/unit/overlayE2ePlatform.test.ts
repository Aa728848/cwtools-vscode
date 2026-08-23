import { expect } from 'chai';
const { platformTarget } = require('../../../tools/run-overlay-e2e.cjs');
describe('overlay E2E platform target', () => {
  it('maps supported operating systems and architectures', () => {
    expect(platformTarget('win32', 'x64')).to.deep.equal({ rid: 'win-x64', folder: 'win-x64' });
    expect(platformTarget('darwin', 'arm64')).to.deep.equal({ rid: 'osx-arm64', folder: 'osx-arm64' });
    expect(platformTarget('linux', 'x64')).to.deep.equal({ rid: 'linux-x64', folder: 'linux-x64' });
  });
  it('rejects unsupported platforms', () => expect(() => platformTarget('freebsd', 'x64')).to.throw('Unsupported'));
});
