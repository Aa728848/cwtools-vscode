import { expect } from 'chai';
const { platformTarget } = require('../../../tools/run-overlay-e2e.cjs');
describe('overlay E2E platform target', () => {
  it('maps supported operating systems and architectures', () => {
    expect(platformTarget('win32', 'x64')).to.deep.equal({ target: 'x86_64-pc-windows-msvc', folder: 'win-x64', source: 'cwtools-lsp.exe', executable: 'CWTools Server.exe' });
    expect(platformTarget('darwin', 'arm64')).to.deep.equal({ target: 'aarch64-apple-darwin', folder: 'osx-arm64', source: 'cwtools-lsp', executable: 'CWTools Server' });
    expect(platformTarget('linux', 'x64')).to.deep.equal({ target: 'x86_64-unknown-linux-gnu', folder: 'linux-x64', source: 'cwtools-lsp', executable: 'CWTools Server' });
  });
  it('rejects unsupported platforms', () => expect(() => platformTarget('freebsd', 'x64')).to.throw('Unsupported'));
});
