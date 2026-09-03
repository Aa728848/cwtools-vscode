import { expect } from 'chai';
import { shouldBypassWriteConfirmation } from '../../extension/ai/tools/writeConfirmation';

describe('writeConfirmation unit tests', () => {
    describe('fileWriteMode switch', () => {
        it('bypasses confirmation when fileWriteMode is auto', () => {
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'auto' })).to.be.true;
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'auto', args: { _autoApply: false } })).to.be.true;
        });

        it('does not bypass confirmation when fileWriteMode is confirm and all bypass switches are false', () => {
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'confirm' })).to.be.false;
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'confirm', args: {} })).to.be.false;
        });

        it('defaults to requiring confirmation when mode is undefined or confirm', () => {
            expect(shouldBypassWriteConfirmation({})).to.be.false;
            expect(shouldBypassWriteConfirmation({ args: null })).to.be.false;
        });
    });

    describe('vfsOverlay switch', () => {
        it('bypasses confirmation when vfsOverlay is active', () => {
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'confirm', vfsOverlay: true })).to.be.true;
        });

        it('requires confirmation when vfsOverlay is false in confirm mode', () => {
            expect(shouldBypassWriteConfirmation({ fileWriteMode: 'confirm', vfsOverlay: false })).to.be.false;
        });
    });

    describe('args._autoApply switch', () => {
        it('bypasses confirmation when args._autoApply is true', () => {
            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                args: { _autoApply: true, file: 'test.txt' },
            })).to.be.true;
        });

        it('requires confirmation when args._autoApply is false or truthy non-boolean', () => {
            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                args: { _autoApply: false },
            })).to.be.false;

            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                args: { _autoApply: 'true' as any },
            })).to.be.false;
        });
    });

    describe('runnerOptions switches', () => {
        it('bypasses confirmation when forceAutoApplyWrites is true', () => {
            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                runnerOptions: { forceAutoApplyWrites: true },
            })).to.be.true;
        });

        it('bypasses confirmation when useSlimPrompt is true', () => {
            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                runnerOptions: { useSlimPrompt: true },
            })).to.be.true;
        });

        it('requires confirmation when runnerOptions switches are false', () => {
            expect(shouldBypassWriteConfirmation({
                fileWriteMode: 'confirm',
                runnerOptions: { forceAutoApplyWrites: false, useSlimPrompt: false },
            })).to.be.false;
        });
    });

    describe('exhaustive 4-switch truth table in confirm mode', () => {
        const booleanValues = [false, true];

        for (const autoApply of booleanValues) {
            for (const forceAutoApply of booleanValues) {
                for (const useSlimPrompt of booleanValues) {
                    for (const vfsOverlay of booleanValues) {
                        const expectedBypass = autoApply || forceAutoApply || useSlimPrompt || vfsOverlay;
                        const label = `_autoApply=${autoApply}, force=${forceAutoApply}, slim=${useSlimPrompt}, vfs=${vfsOverlay} -> ${expectedBypass}`;
                        it(label, () => {
                            const result = shouldBypassWriteConfirmation({
                                fileWriteMode: 'confirm',
                                args: { _autoApply: autoApply },
                                runnerOptions: {
                                    forceAutoApplyWrites: forceAutoApply,
                                    useSlimPrompt,
                                },
                                vfsOverlay,
                            });
                            expect(result).to.equal(expectedBypass);
                        });
                    }
                }
            }
        }
    });
});
