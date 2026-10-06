import { expect } from 'chai';
import { sanitizeOutboundText } from '../../extension/ai/outboundText';

describe('Outbound text sanitization', () => {
    // A NUL is representable in a JS string but not in JSON, so the whole body is
    // rejected as malformed and the turn fails for a reason the user cannot see.
    it('drops a NUL', () => {
        expect(sanitizeOutboundText('a' + String.fromCharCode(0) + 'b')).to.equal('ab');
    });

    // An emoji sliced mid-pair leaves one surrogate. The hardest one to diagnose
    // because the text sits in history: every LATER request fails the same way.
    it('drops an unpaired surrogate', () => {
        expect(sanitizeOutboundText('a' + String.fromCharCode(0xd83d) + 'b')).to.equal('ab');
        expect(sanitizeOutboundText('a' + String.fromCharCode(0xde00) + 'b')).to.equal('ab');
    });

    // A whole emoji is a VALID pair and must survive: a removed emoji is harder to
    // explain than the bad request it was meant to prevent.
    it('keeps a complete pair', () => {
        expect(sanitizeOutboundText('hi ' + String.fromCodePoint(0x1f600) + ' there'))
            .to.equal('hi ' + String.fromCodePoint(0x1f600) + ' there');
    });

    it('leaves ordinary text untouched', () => {
        expect(sanitizeOutboundText('plain text')).to.equal('plain text');
        expect(sanitizeOutboundText('')).to.equal('');
    });
});
