import { expect } from 'chai';
import { inferBuildModeRoute, parseModelRouteResponse } from '../../extension/ai/modeRouting';

describe('mode routing', () => {
    it('routes planning requests from build mode into plan mode', () => {
        expect(inferBuildModeRoute('Design an event chain blueprint before implementation')).to.equal('plan');
        expect(inferBuildModeRoute('先规划一个事件链方案')).to.equal('plan');
    });

    it('routes read-only investigation requests into explore mode', () => {
        expect(inferBuildModeRoute('Find where this scripted_trigger is referenced')).to.equal('explore');
        expect(inferBuildModeRoute('帮我查找这个触发器在哪里用到')).to.equal('explore');
    });

    it('routes review requests into review mode', () => {
        expect(inferBuildModeRoute('Review the rules sync diagnostics and report risks')).to.equal('review');
        expect(inferBuildModeRoute('审查这次规则同步的问题')).to.equal('review');
    });

    it('routes PDX write requests into script mode', () => {
        expect(inferBuildModeRoute('Fix all localisation errors in this Stellaris mod')).to.equal('script');
        expect(inferBuildModeRoute('修复这些 CWT 诊断报错')).to.equal('script');
    });

    it('routes non-PDX helper script requests into utility mode', () => {
        expect(inferBuildModeRoute('Create a Python converter for this CSV file')).to.equal('utility');
    });

    it('leaves ordinary build requests unchanged when there is no clear route', () => {
        expect(inferBuildModeRoute('Please make the requested change')).to.equal(undefined);
    });

    it('parses model routing JSON responses', () => {
        expect(parseModelRouteResponse('{"mode":"script","confidence":0.91}')).to.equal('script');
        expect(parseModelRouteResponse('Result: {"mode":"review","confidence":0.8}')).to.equal('review');
    });

    it('ignores build and low-confidence model routing responses', () => {
        expect(parseModelRouteResponse('{"mode":"build","confidence":0.99}')).to.equal(undefined);
        expect(parseModelRouteResponse('{"mode":"script","confidence":0.2}')).to.equal(undefined);
    });
});
