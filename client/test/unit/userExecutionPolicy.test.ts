import { expect } from 'chai';
import { deriveUserExecutionPolicy } from '../../extension/ai/orchestrator/userExecutionPolicy';

describe('UserExecutionPolicy', () => {
    it('keeps localisation user-owned when the user says they will write it', () => {
        expect(deriveUserExecutionPolicy('功能代码你来写，本地化由我自己处理。', undefined)).to.deep.equal({
            localisationOwnership: 'user',
            warningHandling: 'enforce',
        });
    });

    it('maps an ignore-errors request to warnings only', () => {
        expect(deriveUserExecutionPolicy('先无视这些错误和黄色警告，继续完成任务。', undefined)).to.deep.equal({
            localisationOwnership: 'agent',
            warningHandling: 'ignore',
        });
    });

    it('accepts the coordinator interpretation without weakening an explicit user constraint', () => {
        expect(deriveUserExecutionPolicy(
            '本地化我来写。',
            { localisationOwnership: 'agent', warningHandling: 'ignore' },
        )).to.deep.equal({
            localisationOwnership: 'user',
            warningHandling: 'ignore',
        });
    });
});
