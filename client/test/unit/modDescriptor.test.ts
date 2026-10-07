import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DESCRIPTOR_FILE_NAME,
    getDescriptorPath,
    readDescriptor,
    writeRemoteFileId,
} from '../../extension/modDescriptor';

describe('mod descriptor', () => {
    const tempBase = path.join(os.tmpdir(), 'cwtools-mod-descriptor');

    function makeModRoot(descriptor?: string): string {
        fs.mkdirSync(tempBase, { recursive: true });
        const root = fs.mkdtempSync(path.join(tempBase, 'descriptor-test-'));
        if (descriptor !== undefined) {
            fs.writeFileSync(path.join(root, DESCRIPTOR_FILE_NAME), descriptor, 'utf8');
        }
        return root;
    }

    function cleanup(root: string): void {
        fs.rmSync(root, { recursive: true, force: true });
        try {
            fs.rmdirSync(tempBase);
        } catch {
            // directory not empty or busy
        }
    }

    // Read the bytes themselves: another suite replaces the global
    // `fs.readFileSync` with a CRLF-normalising shim, which would hide the
    // line endings these tests assert on.
    function readRaw(root: string): string {
        return fs.readFileSync(path.join(root, DESCRIPTOR_FILE_NAME)).toString('utf8');
    }

    describe('getDescriptorPath', () => {
        it('resolves descriptor.mod inside the mod root', () => {
            expect(getDescriptorPath(path.join('mods', 'sample'))).to.equal(path.join('mods', 'sample', 'descriptor.mod'));
        });
    });

    describe('readDescriptor', () => {
        it('reports a missing descriptor without warnings', () => {
            const root = makeModRoot();
            try {
                expect(readDescriptor(root)).to.deep.equal({ exists: false });
            } finally {
                cleanup(root);
            }
        });

        it('parses every declared field', () => {
            const root = makeModRoot([
                'name="Sample Mod"',
                'version="1.2.3"',
                'supported_version="3.12.*"',
                'remote_file_id="123456789"',
                'tags={ "Fleet" "Events" }',
                'dependencies={ "Another Mod" "Third Mod" }',
                '',
            ].join('\n'));
            try {
                expect(readDescriptor(root)).to.deep.equal({
                    exists: true,
                    name: 'Sample Mod',
                    version: '1.2.3',
                    supportedVersion: '3.12.*',
                    remoteFileId: '123456789',
                    tags: ['Fleet', 'Events'],
                    dependencies: ['Another Mod', 'Third Mod'],
                    warnings: [],
                });
            } finally {
                cleanup(root);
            }
        });

        it('parses unquoted scalar values and multi-line tags blocks', () => {
            const root = makeModRoot([
                'name=Bare Mod',
                'supported_version=3.*',
                'tags={',
                '    "Fleet"',
                '    "Events"',
                '}',
                '',
            ].join('\n'));
            try {
                const descriptor = readDescriptor(root);
                expect(descriptor.name).to.equal('Bare Mod');
                expect(descriptor.supportedVersion).to.equal('3.*');
                expect(descriptor.tags).to.deep.equal(['Fleet', 'Events']);
                expect(descriptor.warnings).to.deep.equal([]);
            } finally {
                cleanup(root);
            }
        });

        it('leaves absent fields undefined and tags/dependencies empty', () => {
            const root = makeModRoot('name="Only A Name"\n');
            try {
                const descriptor = readDescriptor(root);
                expect(descriptor.exists).to.equal(true);
                expect(descriptor.name).to.equal('Only A Name');
                expect(descriptor.version).to.equal(undefined);
                expect(descriptor.supportedVersion).to.equal(undefined);
                expect(descriptor.remoteFileId).to.equal(undefined);
                expect(descriptor.tags).to.deep.equal([]);
                expect(descriptor.dependencies).to.deep.equal([]);
                expect(descriptor.warnings).to.deep.equal([]);
            } finally {
                cleanup(root);
            }
        });

        it('deduplicates dependencies but keeps repeated tags', () => {
            const root = makeModRoot([
                'tags={ "Fleet" "Fleet" }',
                'dependencies={ "Another Mod" "Another Mod" "Third Mod" }',
                '',
            ].join('\n'));
            try {
                const descriptor = readDescriptor(root);
                expect(descriptor.tags).to.deep.equal(['Fleet', 'Fleet']);
                expect(descriptor.dependencies).to.deep.equal(['Another Mod', 'Third Mod']);
            } finally {
                cleanup(root);
            }
        });

        it('warns instead of throwing when declared fields cannot be parsed', () => {
            const root = makeModRoot([
                'name="Broken Mod"',
                'supported_version=""',
                'remote_file_id="not-a-number"',
                'dependencies={ }',
                '',
            ].join('\n'));
            try {
                const descriptor = readDescriptor(root);
                expect(descriptor.exists).to.equal(true);
                expect(descriptor.supportedVersion).to.equal(undefined);
                expect(descriptor.remoteFileId).to.equal(undefined);
                expect(descriptor.warnings).to.deep.equal([
                    'descriptor.mod declares supported_version but it could not be parsed.',
                    'descriptor.mod declares remote_file_id but it could not be parsed.',
                    'descriptor.mod declares dependencies but none could be parsed.',
                ]);
            } finally {
                cleanup(root);
            }
        });

        it('reads a CRLF descriptor', () => {
            const root = makeModRoot('name="Windows Mod"\r\nremote_file_id="42"\r\n');
            try {
                const descriptor = readDescriptor(root);
                expect(descriptor.name).to.equal('Windows Mod');
                expect(descriptor.remoteFileId).to.equal('42');
                expect(descriptor.warnings).to.deep.equal([]);
            } finally {
                cleanup(root);
            }
        });
    });

    describe('writeRemoteFileId', () => {
        it('replaces an existing quoted value in place', () => {
            const root = makeModRoot([
                'name="Sample Mod"',
                'remote_file_id="111"',
                'supported_version="3.12.*"',
                '',
            ].join('\n'));
            try {
                writeRemoteFileId(getDescriptorPath(root), '987654321');

                expect(readRaw(root)).to.equal([
                    'name="Sample Mod"',
                    'remote_file_id="987654321"',
                    'supported_version="3.12.*"',
                    '',
                ].join('\n'));
                expect(readDescriptor(root).remoteFileId).to.equal('987654321');
            } finally {
                cleanup(root);
            }
        });

        it('replaces an unquoted value and keeps the line indentation', () => {
            const root = makeModRoot(['name="Sample Mod"', '\tremote_file_id = 111', ''].join('\n'));
            try {
                writeRemoteFileId(getDescriptorPath(root), '222');

                expect(readRaw(root)).to.equal(['name="Sample Mod"', '\tremote_file_id = "222"', ''].join('\n'));
                // The reader only recognises column-0 declarations, so an indented
                // line stays invisible to it exactly as it was before the write.
                expect(readDescriptor(root).remoteFileId).to.equal(undefined);
            } finally {
                cleanup(root);
            }
        });

        it('replaces only the first declaration when duplicates exist', () => {
            const root = makeModRoot(['remote_file_id="111"', 'remote_file_id="222"', ''].join('\n'));
            try {
                writeRemoteFileId(getDescriptorPath(root), '333');

                expect(readRaw(root)).to.equal(['remote_file_id="333"', 'remote_file_id="222"', ''].join('\n'));
            } finally {
                cleanup(root);
            }
        });

        it('appends the declaration when the descriptor has none', () => {
            const root = makeModRoot(['name="Sample Mod"', 'supported_version="3.12.*"'].join('\n'));
            try {
                writeRemoteFileId(getDescriptorPath(root), '444');

                expect(readRaw(root)).to.equal([
                    'name="Sample Mod"',
                    'supported_version="3.12.*"',
                    'remote_file_id="444"',
                    '',
                ].join('\n'));
                expect(readDescriptor(root).remoteFileId).to.equal('444');
                expect(readDescriptor(root).warnings).to.deep.equal([]);
            } finally {
                cleanup(root);
            }
        });

        it('appends to an empty descriptor', () => {
            const root = makeModRoot('');
            try {
                writeRemoteFileId(getDescriptorPath(root), '555');

                expect(readRaw(root)).to.equal('remote_file_id="555"\n');
                expect(readDescriptor(root).remoteFileId).to.equal('555');
            } finally {
                cleanup(root);
            }
        });

        it('appends instead of rewriting a commented-out declaration', () => {
            const root = makeModRoot(['name="Sample Mod"', '# remote_file_id="111"', ''].join('\n'));
            try {
                writeRemoteFileId(getDescriptorPath(root), '666');

                expect(readRaw(root)).to.equal([
                    'name="Sample Mod"',
                    '# remote_file_id="111"',
                    'remote_file_id="666"',
                    '',
                ].join('\n'));
                expect(readDescriptor(root).remoteFileId).to.equal('666');
            } finally {
                cleanup(root);
            }
        });

        it('preserves CRLF when appending', () => {
            const root = makeModRoot('name="Sample Mod"\r\nsupported_version="3.12.*"\r\n');
            try {
                writeRemoteFileId(getDescriptorPath(root), '777');

                const raw = readRaw(root);
                expect(raw).to.equal([
                    'name="Sample Mod"',
                    'supported_version="3.12.*"',
                    'remote_file_id="777"',
                    '',
                ].join('\r\n'));
                expect(raw.replace(/\r\n/g, '')).to.not.contain('\n');
                expect(readDescriptor(root).remoteFileId).to.equal('777');
            } finally {
                cleanup(root);
            }
        });

        it('preserves CRLF when replacing', () => {
            const root = makeModRoot('name="Sample Mod"\r\nremote_file_id="111"\r\n');
            try {
                writeRemoteFileId(getDescriptorPath(root), '888');

                const raw = readRaw(root);
                expect(raw).to.equal('name="Sample Mod"\r\nremote_file_id="888"\r\n');
                expect(raw.replace(/\r\n/g, '')).to.not.contain('\n');
                expect(readDescriptor(root).remoteFileId).to.equal('888');
            } finally {
                cleanup(root);
            }
        });

        it('writes UTF-8 for non-ASCII content', () => {
            const root = makeModRoot('name="星海模组"\n');
            try {
                writeRemoteFileId(getDescriptorPath(root), '999');

                expect(readRaw(root)).to.equal('name="星海模组"\nremote_file_id="999"\n');
                expect(readDescriptor(root).name).to.equal('星海模组');
                expect(readDescriptor(root).remoteFileId).to.equal('999');
            } finally {
                cleanup(root);
            }
        });

        it('refuses a non-numeric id instead of writing an unreadable descriptor', () => {
            const root = makeModRoot('name="Sample Mod"\n');
            try {
                expect(() => writeRemoteFileId(getDescriptorPath(root), 'not-a-number')).to.throw(/non-numeric remote_file_id/);
                expect(readRaw(root)).to.equal('name="Sample Mod"\n');
            } finally {
                cleanup(root);
            }
        });
    });
});
