import { expect } from 'chai';
import {
    buildPlanModeSystemPrompt,
    buildGeneralPlanSystemPrompt,
} from '../../extension/ai/prompt/sections/modePrompts';

describe('plan mode prompts', () => {
    it('requires a plan or a structured question as the only acceptable conclusion', () => {
        const paradox = buildPlanModeSystemPrompt('', 'Stellaris');
        expect(paradox).to.include('Conclude every Plan Mode turn with exactly one of');
        expect(paradox).to.include(':::question');
        expect(paradox).to.include('Plain prose such as "I cannot produce the plan yet" is not an acceptable conclusion');
        // 澄清答复后必须同一延续轮交付完整计划,禁止转入执行。
        expect(paradox).to.include('never switch to execution');
    });

    it('keeps the general plan boundary on the same plan-or-question contract', () => {
        const general = buildGeneralPlanSystemPrompt(false);
        expect(general).to.include('Conclude every turn with either the complete plan plus the `cwtools-plan` block');
        expect(general).to.include(':::question');
        expect(general).to.include('After the user answers a clarification, deliver the complete plan in the same continuation turn');
        // 旧的“ask the user and stop”散文收尾许可已被移除。
        expect(general).to.not.include('ask the user and stop');
    });
});
