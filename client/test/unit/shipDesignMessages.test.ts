import { expect } from 'chai';
import { ShipDesignEditError } from '../../extension/shipDesign/designDocument';
import { shipDesignErrorText } from '../../extension/shipDesign/messages';

describe('ship design user-facing messages', () => {
    const zh = (_en: string, cn: string): string => cn;
    const en = (english: string): string => english;

    it('maps every edit error code to the display language', () => {
        expect(shipDesignErrorText(new ShipDesignEditError('incompatible-drop', 'Component size large does not fit small slot.'), zh))
            .to.equal('该部件无法放入此槽位。');
        expect(shipDesignErrorText(new ShipDesignEditError('version-conflict', 'raw'), en)).to.contain('Your draft is preserved');
        expect(shipDesignErrorText(new ShipDesignEditError('boolean-required', 'auto_gen_design requires a boolean value.'), zh))
            .to.equal('该字段只能是 yes 或 no。');
    });

    it('keeps the original message for unknown codes and plain errors', () => {
        expect(shipDesignErrorText(new ShipDesignEditError('future-code', 'detail'), zh)).to.equal('detail');
        expect(shipDesignErrorText(new Error('plain'), zh)).to.equal('plain');
        expect(shipDesignErrorText('text', zh)).to.equal('text');
    });
});
