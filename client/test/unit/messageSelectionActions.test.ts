import { expect } from 'chai';
import { formatSelectionForTask } from '../../webview/chat/messageSelectionActions';

describe('message selection actions', () => {
    it('formats selected message text as a compact task quote', () => {
        expect(formatSelectionForTask('  first line\r\n\r\nsecond line  ')).to.equal(
            '> first line\n>\n> second line',
        );
    });
});
