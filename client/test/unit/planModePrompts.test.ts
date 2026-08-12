import { expect } from 'chai';
import {
    buildPlanModeSystemPrompt,
    buildGeneralPlanSystemPrompt,
} from '../../extension/ai/prompt/sections/modePrompts';

describe('plan mode prompts', () => {
    it('uses the structured question tool for blocking plan decisions', () => {
        const paradox = buildPlanModeSystemPrompt('', 'Stellaris');
        expect(paradox).to.include('call `ask_user_question` as the only tool call');
        expect(paradox).to.include('the UI adds Other automatically');
        expect(paradox).to.not.include(':::question');
        expect(paradox).to.include('never switch to execution');
    });

    it('keeps the general plan boundary on the same structured-tool contract', () => {
        const general = buildGeneralPlanSystemPrompt(false);
        expect(general).to.include('call `ask_user_question` as the only tool call');
        expect(general).to.include('After the tool returns, deliver the complete plan in the same run');
        expect(general).to.not.include(':::question');
    });
});
