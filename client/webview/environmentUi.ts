/**
 * Shared environment selector UI for preview panels (entity / particle).
 * Renders a preset dropdown and a color-LUT toggle into a panel toolbar.
 * Pure DOM — all Three.js work lives in skyboxEnvironment.ts.
 */
import type { EnvironmentPreset } from './environmentTypes';

export interface EnvironmentUiState {
    presetId: string | null;
    backgroundIndex: number;
    lutEnabled: boolean;
}

export const DEFAULT_ENV_STATE: EnvironmentUiState = {
    presetId: null,
    backgroundIndex: -1,
    lutEnabled: true,
};

const uiText = {
    envLabel: { en: 'Environment', zh: '环境' },
    none: { en: 'None', zh: '无' },
    lut: { en: 'LUT', zh: 'LUT' },
    lutTitle: { en: 'Color grading (color_lut)', zh: '色彩分级（color_lut）' },
    presetTitle: { en: 'Skybox environment (gfx/worldgfx)', zh: '天空盒环境（gfx/worldgfx）' },
} as const;

export class EnvironmentUi {
    readonly root: HTMLSpanElement;
    private readonly presetSelect: HTMLSelectElement;
    private readonly lutLabel: HTMLLabelElement;
    private readonly lutCheckbox: HTMLInputElement;
    private presets: EnvironmentPreset[] = [];
    private readonly isChinese: boolean;
    private readonly onChange: (state: EnvironmentUiState) => void;

    constructor(isChinese: boolean, onChange: (state: EnvironmentUiState) => void) {
        this.isChinese = isChinese;
        this.onChange = onChange;

        const t = (k: keyof typeof uiText) => (isChinese ? uiText[k].zh : uiText[k].en);

        this.root = document.createElement('span');
        this.root.className = 'env-ui';

        const label = document.createElement('span');
        label.className = 'env-ui-label';
        label.textContent = t('envLabel');

        this.presetSelect = document.createElement('select');
        this.presetSelect.className = 'env-preset-select';
        this.presetSelect.title = t('presetTitle');

        this.lutLabel = document.createElement('label');
        this.lutLabel.className = 'env-lut-label';
        this.lutLabel.title = t('lutTitle');
        this.lutCheckbox = document.createElement('input');
        this.lutCheckbox.type = 'checkbox';
        this.lutCheckbox.checked = true;
        const lutText = document.createElement('span');
        lutText.textContent = t('lut');
        this.lutLabel.append(this.lutCheckbox, lutText);
        this.lutLabel.style.display = 'none';

        this.root.append(label, this.presetSelect, this.lutLabel);

        this.presetSelect.addEventListener('change', () => {
            this.refreshLutVisibility();
            this.emitChange();
        });
        this.lutCheckbox.addEventListener('change', () => this.emitChange());
    }

    setPresets(presets: EnvironmentPreset[]): void {
        this.presets = presets;
        const current = this.presetSelect.value;
        this.presetSelect.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = this.isChinese ? uiText.none.zh : uiText.none.en;
        this.presetSelect.appendChild(none);
        for (const p of presets) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.id;
            this.presetSelect.appendChild(opt);
        }
        this.root.style.display = presets.length > 0 ? '' : 'none';
        if (current && presets.some(p => p.id === current)) {
            this.presetSelect.value = current;
        }
        this.refreshLutVisibility();
    }

    getState(): EnvironmentUiState {
        return {
            presetId: this.presetSelect.value || null,
            backgroundIndex: -1, // background is auto-picked (catch-all `always = yes` entry)
            lutEnabled: this.lutCheckbox.checked,
        };
    }

    setState(state: Partial<EnvironmentUiState>): void {
        if (state.presetId && this.presets.some(p => p.id === state.presetId)) {
            this.presetSelect.value = state.presetId;
        }
        if (typeof state.lutEnabled === 'boolean') {
            this.lutCheckbox.checked = state.lutEnabled;
        }
        this.refreshLutVisibility();
    }

    private refreshLutVisibility(): void {
        const preset = this.presets.find(p => p.id === this.presetSelect.value);
        this.lutLabel.style.display = preset?.colorLutUri ? '' : 'none';
    }

    private emitChange(): void {
        this.onChange(this.getState());
    }
}
