import { expect } from 'chai';
import {
    GUI_SAFE_HIDDEN_POSITION,
    validateOffCanvasGuiPreservation,
} from '../../extension/guiSafety';

function guiWithChild(child: string): string {
    return [
        'guiTypes = {',
        '    containerWindowType = {',
        '        name = "root_window"',
        '        position = { x = 0 y = 0 }',
        child,
        '    }',
        '}',
    ].join('\n');
}

describe('GUI off-canvas safety', () => {
    it('protects named controls hidden with large coordinates', () => {
        const previous = guiWithChild([
            '        buttonType = {',
            '            name = "engine_required_button"',
            `            position = { x = ${GUI_SAFE_HIDDEN_POSITION} y = -11430 }`,
            '        }',
        ].join('\n'));
        const next = guiWithChild('');

        const result = validateOffCanvasGuiPreservation(previous, next);

        expect(result.allowed).to.equal(false);
        expect(result.protectedControls).to.have.length(1);
        expect(result.missingControls[0]).to.include({
            type: 'buttonType',
            name: 'engine_required_button',
            x: GUI_SAFE_HIDDEN_POSITION,
            y: -11430,
        });
    });

    it('resolves project invisible-position variables', () => {
        const previous = [
            '@invisible_position = 23333',
            guiWithChild([
                '        instantTextBoxType = {',
                '            name = "engine_heading"',
                '            position = { x = @invisible_position y = @invisible_position }',
                '        }',
            ].join('\n')),
        ].join('\n');

        const result = validateOffCanvasGuiPreservation(previous, previous);

        expect(result.allowed).to.equal(true);
        expect(result.protectedControls).to.have.length(1);
        expect(result.protectedControls[0]?.x).to.equal(23333);
    });

    it('blocks renaming or reparenting a protected control', () => {
        const child = [
            '        buttonType = {',
            '            name = "required_option"',
            '            position = { x = 11450 y = 11175 }',
            '        }',
        ].join('\n');
        const previous = guiWithChild(child);
        const renamed = previous.replace('"required_option"', '"renamed_option"');
        const reparented = [
            previous.slice(0, previous.lastIndexOf('}')),
            '    containerWindowType = {',
            '        name = "other_parent"',
            child,
            '    }',
            '}',
        ].join('\n').replace(child, '');

        expect(validateOffCanvasGuiPreservation(previous, renamed).allowed).to.equal(false);
        expect(validateOffCanvasGuiPreservation(previous, reparented).allowed).to.equal(false);
    });

    it('does not protect ordinary visible controls from intentional deletion', () => {
        const previous = guiWithChild([
            '        iconType = {',
            '            name = "mod_owned_icon"',
            '            position = { x = 20 y = 30 }',
            '        }',
        ].join('\n'));

        const result = validateOffCanvasGuiPreservation(previous, guiWithChild(''));

        expect(result.allowed).to.equal(true);
        expect(result.protectedControls).to.deep.equal([]);
    });
});
