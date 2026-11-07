import { expect } from 'chai';
import {
    buildPlanModeSystemPrompt,
    buildBuildSystemPrompt,
} from '../../extension/ai/prompt/sections/modePrompts';

describe('plan mode prompts', () => {
    it('requires explicit plan requests to enter Plan even without project writes', () => {
        const prompt = buildBuildSystemPrompt('', 'Stellaris', false);
        expect(prompt).to.include('even if this turn will make no project writes');
        expect(prompt).to.include('before drafting the deliverable');
        expect(prompt).to.include('Only when the user has NOT explicitly requested a plan');
    });

    it('uses the structured question tool for blocking plan decisions', () => {
        const paradox = buildPlanModeSystemPrompt('', 'Stellaris');
        expect(paradox).to.include('call `ask_user_question` as the only tool call');
        expect(paradox).to.include('the UI adds Other automatically');
        expect(paradox).to.not.include(':::question');
        expect(paradox).to.include('never switch to execution');
    });

    it('requires pre-write clarification via ask_user_question in execution mode prompts', () => {
        const buildPrompt = buildBuildSystemPrompt('', 'Stellaris', false);
        expect(buildPrompt).to.include('call `ask_user_question` as the only tool call to confirm direction');
        expect(buildPrompt).to.include('clarify BEFORE making any modifications');
        expect(buildPrompt).to.include('Never rush to mutate files on guesswork and only ask afterwards');
    });
});
