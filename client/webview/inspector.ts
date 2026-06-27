import type { AnimatedValue, AnimationCurve, Force, ParticleEffect, Range, Scalar, Subsystem } from './particleTypes';
import { isRange } from './particleTypes';

export interface FieldEditOptions {
    reload?: boolean;
}

export interface InspectorCallbacks {
    onFieldEdit(path: Array<string | number>, value: unknown, options?: FieldEditOptions): void;
    onDirty(): void;
}

const EMITTER_TYPES = ['point', 'sphere', 'box'];
const SORT_TYPES = ['depth', 'age', 'distance'];
const SHADERS = ['ParticleAdditive', 'ParticleAlphaBlend'];
const MAX_SCALAR_CELLS = 8;

function scalarNumber(value: Scalar | undefined, fallback = 0): number {
    if (!value) return fallback;
    return isRange(value) ? value.a.value : value.value;
}

function ensureAnimated(value: Scalar | undefined, fallback = 0): AnimatedValue {
    if (!value) return { value: fallback, rawStyle: 'raw' };
    return isRange(value) ? value.a : value;
}

function makeAnimated(value: number): AnimatedValue {
    return { value, rawStyle: Number.isInteger(value) ? 'int' : 'raw' };
}

function cloneAnimated(value: AnimatedValue): AnimatedValue {
    return { ...value };
}

function cloneEditableAnimated(value: AnimatedValue): AnimatedValue {
    const clone = { ...value, suffixes: value.suffixes ? [...value.suffixes] : undefined };
    delete clone.span;
    return clone;
}

function styleOfInput(raw: string) {
    if (/^[+-]?\d+$/.test(raw)) return 'int';
    if (/^[+-]?\d+\.\d$/.test(raw)) return 'fixed1';
    if (/^[+-]?\d+\.\d{2}$/.test(raw)) return 'fixed2';
    if (/^[+-]?\d+\.\d{3}$/.test(raw)) return 'fixed3';
    if (/^[+-]?\d+\.\d{4}$/.test(raw)) return 'fixed4';
    if (/^[+-]?\d+\.\d{5}$/.test(raw)) return 'fixed5';
    if (/^[+-]?\d+\.\d{6}$/.test(raw)) return 'fixed6';
    return 'raw';
}

function isNumericCellText(text: string): boolean {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text.trim());
}

function primaryCellText(value: AnimatedValue): string {
    return value.raw ?? String(value.value);
}

function animatedValuesFromScalar(value: Scalar): AnimatedValue[] {
    if (!isRange(value)) return [cloneAnimated(value)];
    return [value.a, value.b, ...(value.extras ?? [])].map(cloneAnimated);
}

function scalarFromAnimatedValues(values: AnimatedValue[], fallback: number): Scalar {
    const safeValues = values.length ? values.map(cloneEditableAnimated) : [makeAnimated(fallback)];
    if (safeValues.length === 1) return safeValues[0]!;
    const [a, b, ...extras] = safeValues;
    return {
        a: a!,
        b: b ?? cloneEditableAnimated(a!),
        extras: extras.length ? extras : undefined,
    };
}

export class ParticleInspector {
    private readonly root: HTMLElement;

    constructor(root: HTMLElement) {
        this.root = root;
    }

    render(effect: ParticleEffect | undefined, subsystemIndex: number, callbacks: InspectorCallbacks): void {
        this.root.innerHTML = '';
        if (!effect || !effect.subsystems[subsystemIndex]) {
            this.root.append(this.empty('No subsystem selected'));
            return;
        }
        const subsystem = effect.subsystems[subsystemIndex]!;
        const basePath: Array<string | number> = ['subsystems', subsystemIndex];
        const animationNames = effect.animations.map(curve => curve.name).filter(Boolean);
        const forceNames = effect.forces.map(force => force.name).filter(Boolean);

        this.root.append(
            this.group('Subsystem', [
                this.textField('Name', subsystem.name ?? '', [...basePath, 'name'], callbacks),
                this.numberField('Max particles', subsystem.maxAmount ?? 128, [...basePath, 'maxAmount'], callbacks, 1, 1),
                this.numberField('Slave particles', subsystem.slaveParticles ?? 0, [...basePath, 'slaveParticles'], callbacks, 1, 0),
                this.cycleField('Sort type', subsystem.sort ?? 'depth', SORT_TYPES, [...basePath, 'sort'], callbacks),
                this.checkboxField('Local Space', subsystem.localSpace ?? false, [...basePath, 'localSpace'], callbacks),
                this.invertedCheckboxField('No billboard', subsystem.billboard ?? true, [...basePath, 'billboard'], callbacks),
                this.checkboxField('Hidden', subsystem.hide ?? false, [...basePath, 'hide'], callbacks),
            ]),
            this.group('Emitter - General', [
                this.cycleField('Type', subsystem.emitterType ?? 'point', EMITTER_TYPES, [...basePath, 'emitterType'], callbacks),
                this.scalarField('Sphere radius', subsystem.sphereEmitterRadius, [...basePath, 'sphereEmitterRadius'], callbacks, animationNames, 0),
                this.scalarField('Box X', subsystem.boxEmitterX, [...basePath, 'boxEmitterX'], callbacks, animationNames, 0),
                this.scalarField('Box Y', subsystem.boxEmitterY, [...basePath, 'boxEmitterY'], callbacks, animationNames, 0),
                this.scalarField('Box Z', subsystem.boxEmitterZ, [...basePath, 'boxEmitterZ'], callbacks, animationNames, 0),
            ]),
            this.group('Emitter - Position and Rotation', [
                this.scalarField('Position X', subsystem.position?.x, [...basePath, 'position', 'x'], callbacks, animationNames, 0),
                this.scalarField('Position Y', subsystem.position?.y, [...basePath, 'position', 'y'], callbacks, animationNames, 0),
                this.scalarField('Position Z', subsystem.position?.z, [...basePath, 'position', 'z'], callbacks, animationNames, 0),
                this.scalarField('Emitter Yaw', subsystem.emitterYaw, [...basePath, 'emitterYaw'], callbacks, animationNames, 0),
                this.scalarField('Emitter Pitch', subsystem.emitterPitch, [...basePath, 'emitterPitch'], callbacks, animationNames, 0),
            ]),
            this.group('Emission', [
                this.scalarField('Duration', subsystem.duration, [...basePath, 'duration'], callbacks, animationNames, -1),
                this.scalarField('Rate', subsystem.emission, [...basePath, 'emission'], callbacks, animationNames, 24),
                this.scalarField('Pulse Duration', subsystem.emissionPulseDuration, [...basePath, 'emissionPulseDuration'], callbacks, animationNames, 0),
                this.scalarField('Pulse Silence', subsystem.emissionPulseSilence, [...basePath, 'emissionPulseSilence'], callbacks, animationNames, 0),
                this.scalarField('Start delay', subsystem.start, [...basePath, 'start'], callbacks, animationNames, 0),
                this.scalarField('Velocity', subsystem.velocity, [...basePath, 'velocity'], callbacks, animationNames, 1),
                this.scalarField('Velocity Yaw', subsystem.velocityYaw, [...basePath, 'velocityYaw'], callbacks, animationNames, 0),
                this.scalarField('Velocity Pitch', subsystem.velocityPitch, [...basePath, 'velocityPitch'], callbacks, animationNames, 0),
            ]),
            this.group('Behavior', [
                this.scalarField('Lifetime', subsystem.life, [...basePath, 'life'], callbacks, animationNames, 1),
                this.scalarField('Rotation', subsystem.rotation, [...basePath, 'rotation'], callbacks, animationNames, 0),
                this.scalarField('Particle Yaw', subsystem.particleYaw, [...basePath, 'particleYaw'], callbacks, animationNames, 0),
                this.scalarField('Particle Pitch', subsystem.particlePitch, [...basePath, 'particlePitch'], callbacks, animationNames, 0),
                this.scalarField('Particle Roll', subsystem.particleRoll, [...basePath, 'particleRoll'], callbacks, animationNames, 0),
                this.selectField('Force', subsystem.force ?? '', ['', ...forceNames], [...basePath, 'force'], callbacks),
                this.scalarField('Mass', subsystem.mass, [...basePath, 'mass'], callbacks, animationNames, 1),
            ]),
            this.group('Appearance', [
                this.textField('Texture name', subsystem.texture?.file ?? '', [...basePath, 'texture', 'file'], callbacks),
                this.cycleField('Shader name', subsystem.texture?.shader ?? 'ParticleAdditive', SHADERS, [...basePath, 'texture', 'shader'], callbacks),
                this.checkboxField('Trail', subsystem.trail ?? false, [...basePath, 'trail'], callbacks),
                this.checkboxField('Spritesheet animation', subsystem.spritesheetAnimation ?? false, [...basePath, 'spritesheetAnimation'], callbacks),
                this.numberField('Spritesheet looping', subsystem.spritesheetAnimationLoop ?? 0, [...basePath, 'spritesheetAnimationLoop'], callbacks, 0.1, 0),
                this.numberField('X Tile', subsystem.texture?.x ?? 1, [...basePath, 'texture', 'x'], callbacks, 1, 1),
                this.numberField('Y Tile', subsystem.texture?.y ?? 1, [...basePath, 'texture', 'y'], callbacks, 1, 1),
                this.checkboxField('Invert', subsystem.invert ?? false, [...basePath, 'invert'], callbacks),
                this.scalarField('Size', subsystem.size, [...basePath, 'size'], callbacks, animationNames, 1),
                this.scalarField('Red', subsystem.color?.r, [...basePath, 'color', 'r'], callbacks, animationNames, 255),
                this.scalarField('Green', subsystem.color?.g, [...basePath, 'color', 'g'], callbacks, animationNames, 255),
                this.scalarField('Blue', subsystem.color?.b, [...basePath, 'color', 'b'], callbacks, animationNames, 255),
                this.scalarField('Alpha', subsystem.color?.alpha, [...basePath, 'color', 'alpha'], callbacks, animationNames, 255),
            ]),
            this.group('Non billboard rotations', [
                this.scalarField('Speed', subsystem.rotationSpeed, [...basePath, 'rotationSpeed'], callbacks, animationNames, 0),
                this.scalarField('Speed Yaw', subsystem.rotationSpeedYaw, [...basePath, 'rotationSpeedYaw'], callbacks, animationNames, 0),
                this.scalarField('Speed Pitch', subsystem.rotationSpeedPitch, [...basePath, 'rotationSpeedPitch'], callbacks, animationNames, 0),
                this.scalarField('Speed Roll', subsystem.rotationSpeedRoll, [...basePath, 'rotationSpeedRoll'], callbacks, animationNames, 0),
            ]),
        );
    }

    renderForce(effect: ParticleEffect | undefined, forceIndex: number, callbacks: InspectorCallbacks): void {
        this.root.innerHTML = '';
        const force = effect?.forces[forceIndex];
        if (!effect || !force) {
            this.root.append(this.empty('No force selected'));
            return;
        }
        const animationNames = effect.animations.map(curve => curve.name).filter(Boolean);
        const base: Array<string | number> = ['forces', forceIndex];
        this.root.append(
            this.cycleField('Type', force.type, ['planar', 'friction', 'point', 'spin', 'turbulence', 'vortex'], [...base, 'type'], callbacks),
            this.textField('Force name', force.name, [...base, 'name'], callbacks),
            this.checkboxField('Local Force', force.localForce ?? false, [...base, 'localForce'], callbacks),
            this.numberField('Direction X', force.direction?.[0] ?? 0, [...base, 'direction', 0], callbacks),
            this.numberField('Direction Y', force.direction?.[1] ?? 1, [...base, 'direction', 1], callbacks),
            this.numberField('Direction Z', force.direction?.[2] ?? 0, [...base, 'direction', 2], callbacks),
            this.numberField('Position X', force.position?.[0] ?? 0, [...base, 'position', 0], callbacks),
            this.numberField('Position Y', force.position?.[1] ?? 0, [...base, 'position', 1], callbacks),
            this.numberField('Position Z', force.position?.[2] ?? 0, [...base, 'position', 2], callbacks),
            this.numberField('Angle', force.yaw ?? 0, [...base, 'yaw'], callbacks),
            this.numberField('Division', force.division ?? 1, [...base, 'division'], callbacks, 1, 1),
            this.scalarField('Amount', force.amount, [...base, 'amount'], callbacks, animationNames, 1),
        );
    }

    private empty(text: string): HTMLElement {
        const element = document.createElement('div');
        element.className = 'empty-panel';
        element.textContent = text;
        return element;
    }

    private group(title: string, children: HTMLElement[]): HTMLElement {
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = title;
        details.append(summary, ...children);
        return details;
    }

    private row(labelText: string, control: HTMLElement): HTMLElement {
        const row = document.createElement('label');
        row.className = 'inspector-row';
        const label = document.createElement('span');
        label.textContent = labelText;
        row.append(label, control);
        return row;
    }

    private numberField(label: string, value: number, path: Array<string | number>, callbacks: InspectorCallbacks, step = 0.1, min?: number): HTMLElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = String(step);
        if (min !== undefined) input.min = String(min);
        input.value = String(value);
        input.addEventListener('input', () => {
            callbacks.onDirty();
        });
        input.addEventListener('change', () => {
            callbacks.onFieldEdit(path, input.valueAsNumber);
        });
        return this.row(label, input);
    }

    private textField(label: string, value: string, path: Array<string | number>, callbacks: InspectorCallbacks): HTMLElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.addEventListener('input', () => callbacks.onDirty());
        input.addEventListener('change', () => callbacks.onFieldEdit(path, input.value));
        return this.row(label, input);
    }

    private checkboxField(label: string, value: boolean, path: Array<string | number>, callbacks: InspectorCallbacks): HTMLElement {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
        input.addEventListener('change', () => callbacks.onFieldEdit(path, input.checked));
        return this.row(label, input);
    }

    private invertedCheckboxField(label: string, value: boolean, path: Array<string | number>, callbacks: InspectorCallbacks): HTMLElement {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !value;
        input.addEventListener('change', () => callbacks.onFieldEdit(path, !input.checked));
        return this.row(label, input);
    }

    private selectField(label: string, value: string, options: string[], path: Array<string | number>, callbacks: InspectorCallbacks): HTMLElement {
        const select = document.createElement('select');
        for (const option of options) {
            const item = document.createElement('option');
            item.value = option;
            item.textContent = option || '(none)';
            select.append(item);
        }
        select.value = value;
        select.addEventListener('change', () => callbacks.onFieldEdit(path, select.value));
        return this.row(label, select);
    }

    private cycleField(label: string, value: string, options: string[], path: Array<string | number>, callbacks: InspectorCallbacks): HTMLElement {
        const filtered = options.length ? options : [value];
        let index = Math.max(0, filtered.indexOf(value));
        const wrapper = document.createElement('div');
        wrapper.className = 'cycle-control';
        const previous = document.createElement('button');
        previous.type = 'button';
        previous.textContent = '<';
        previous.title = `Previous ${label}`;
        const current = document.createElement('span');
        current.className = 'cycle-value';
        const next = document.createElement('button');
        next.type = 'button';
        next.textContent = '>';
        next.title = `Next ${label}`;
        const update = () => {
            current.textContent = filtered[index] || '(none)';
        };
        const commit = (delta: number) => {
            index = (index + delta + filtered.length) % filtered.length;
            update();
            callbacks.onFieldEdit(path, filtered[index] ?? '');
        };
        previous.addEventListener('click', () => commit(-1));
        next.addEventListener('click', () => commit(1));
        update();
        wrapper.append(previous, current, next);
        return this.row(label, wrapper);
    }

    private scalarField(
        label: string,
        value: Scalar | undefined,
        path: Array<string | number>,
        callbacks: InspectorCallbacks,
        animationNames: string[],
        fallback: number,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'scalar-row';
        const title = document.createElement('span');
        title.textContent = label;
        const controls = document.createElement('div');
        controls.className = 'scalar-controls';
        wrapper.append(title, controls);

        const scalar = value ?? makeAnimated(fallback);
        const values = animatedValuesFromScalar(scalar);
        controls.classList.toggle('scalar-controls-range', values.length > 1);
        values.forEach((item, index) => {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'scalar-range-separator';
                separator.textContent = '~';
                controls.append(separator);
            }
            controls.append(this.scalarValueRow({
                value: item,
                valuePath: isRange(scalar) ? this.scalarValuePath(path, index) : path,
                basePath: path,
                values,
                index,
                isRange: isRange(scalar),
                callbacks,
                animationNames,
                fallback,
            }));
        });
        return wrapper;
    }

    private scalarValuePath(path: Array<string | number>, index: number): Array<string | number> {
        if (index === 0) return [...path, 'a'];
        if (index === 1) return [...path, 'b'];
        return [...path, 'extras', index - 2];
    }

    private scalarValueRow(args: {
        value: AnimatedValue;
        valuePath: Array<string | number>;
        basePath: Array<string | number>;
        values: AnimatedValue[];
        index: number;
        isRange: boolean;
        callbacks: InspectorCallbacks;
        animationNames: string[];
        fallback: number;
    }): HTMLElement {
        const row = document.createElement('div');
        row.className = 'scalar-value-row';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.textContent = '+';
        addButton.title = 'Add range value or comma value';
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = '-';
        removeButton.title = 'Remove comma value or range value';
        const input = this.scalarValueInput(args.value, args.valuePath, args.callbacks);
        addButton.disabled = args.isRange && this.scalarCellCount(args.value) >= MAX_SCALAR_CELLS;
        addButton.addEventListener('click', () => this.addScalarPart(args));
        removeButton.addEventListener('click', () => this.removeScalarPart(args));
        row.append(
            this.scalarCell(input, addButton, removeButton),
            ...this.suffixCells(args.value, args.valuePath, args.callbacks, args.animationNames),
        );
        return row;
    }

    private scalarCell(input: HTMLInputElement, addButton: HTMLButtonElement, removeButton: HTMLButtonElement): HTMLElement {
        const cell = document.createElement('div');
        cell.className = 'scalar-cell';
        cell.append(
            input,
            addButton,
            removeButton,
        );
        return cell;
    }

    private suffixCells(value: AnimatedValue, path: Array<string | number>, callbacks: InspectorCallbacks, animationNames: string[]): HTMLElement[] {
        const suffixes = this.scalarSuffixes(value);
        return suffixes.map((suffix, index) => {
            const cell = document.createElement('div');
            cell.className = 'scalar-cell scalar-suffix-cell';
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'value';
            input.value = suffix;
            input.addEventListener('input', () => callbacks.onDirty());
            input.addEventListener('change', () => {
                const next = this.withSuffix(value, index, input.value.trim() || '0');
                callbacks.onFieldEdit(path, next, { reload: true });
            });
            const add = document.createElement('button');
            add.type = 'button';
            add.textContent = '+';
            add.title = 'Add comma value';
            add.disabled = this.scalarCellCount(value) >= MAX_SCALAR_CELLS;
            add.addEventListener('click', () => {
                const next = this.withInsertedSuffix(value, index + 1, this.defaultCurveName(animationNames));
                callbacks.onFieldEdit(path, next, { reload: true });
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '-';
            remove.title = 'Remove comma value';
            remove.addEventListener('click', () => {
                const next = this.withoutSuffix(value, index);
                callbacks.onFieldEdit(path, next, { reload: true });
            });
            cell.append(input, add, remove);
            return cell;
        });
    }

    private addScalarPart(args: {
        value: AnimatedValue;
        valuePath: Array<string | number>;
        basePath: Array<string | number>;
        values: AnimatedValue[];
        isRange: boolean;
        callbacks: InspectorCallbacks;
        animationNames: string[];
    }): void {
        if (!args.isRange) {
            const a = cloneEditableAnimated(args.value);
            const b = cloneEditableAnimated(args.value);
            const range: Range = { a, b };
            args.callbacks.onFieldEdit(args.basePath, range, { reload: true });
            return;
        }
        if (this.scalarCellCount(args.value) >= MAX_SCALAR_CELLS) return;
        const next = this.withAppendedSuffix(args.value, this.defaultCurveName(args.animationNames));
        args.callbacks.onFieldEdit(args.valuePath, next, { reload: true });
    }

    private removeScalarPart(args: {
        value: AnimatedValue;
        valuePath: Array<string | number>;
        basePath: Array<string | number>;
        values: AnimatedValue[];
        index: number;
        isRange: boolean;
        callbacks: InspectorCallbacks;
        fallback: number;
    }): void {
        if (this.scalarSuffixes(args.value).length > 0) {
            const next = this.withoutSuffix(args.value, this.scalarSuffixes(args.value).length - 1);
            args.callbacks.onFieldEdit(args.valuePath, next, { reload: true });
            return;
        }
        if (!args.isRange) {
            const next = cloneEditableAnimated(args.value);
            next.value = 0;
            next.raw = '0';
            next.rawStyle = 'int';
            args.callbacks.onFieldEdit(args.basePath, next, { reload: true });
            return;
        }
        const hasCurve = args.values.some(value => this.scalarSuffixes(value).length > 0);
        if (args.values.length === 2 && !hasCurve) {
            args.callbacks.onFieldEdit(args.basePath, cloneEditableAnimated(args.values[0]!), { reload: true });
            return;
        }
        if (args.index >= 2) {
            const nextValues = args.values.map(cloneEditableAnimated);
            nextValues.splice(args.index, 1);
            args.callbacks.onFieldEdit(args.basePath, scalarFromAnimatedValues(nextValues, args.fallback), { reload: true });
        }
    }

    private defaultCurveName(animationNames: string[]): string {
        return animationNames[0] || 'curve';
    }

    private scalarSuffixes(value: AnimatedValue): string[] {
        return [value.curve, ...(value.suffixes ?? [])].filter((item): item is string => item !== undefined);
    }

    private scalarCellCount(value: AnimatedValue): number {
        return 1 + this.scalarSuffixes(value).length;
    }

    private withAppendedSuffix(value: AnimatedValue, suffix: string): AnimatedValue {
        return this.withSuffix(value, this.scalarSuffixes(value).length, suffix);
    }

    private withInsertedSuffix(value: AnimatedValue, index: number, suffix: string): AnimatedValue {
        const next = cloneEditableAnimated(value);
        const suffixes = this.scalarSuffixes(value);
        suffixes.splice(index, 0, suffix);
        next.curve = suffixes[0];
        next.suffixes = suffixes.length > 1 ? suffixes.slice(1) : undefined;
        return next;
    }

    private withSuffix(value: AnimatedValue, index: number, suffix: string): AnimatedValue {
        const next = cloneEditableAnimated(value);
        const suffixes = this.scalarSuffixes(value);
        suffixes[index] = suffix;
        next.curve = suffixes[0];
        next.suffixes = suffixes.length > 1 ? suffixes.slice(1) : undefined;
        return next;
    }

    private withoutSuffix(value: AnimatedValue, index: number): AnimatedValue {
        const next = cloneEditableAnimated(value);
        const suffixes = this.scalarSuffixes(value);
        suffixes.splice(index, 1);
        next.curve = suffixes[0];
        next.suffixes = suffixes.length > 1 ? suffixes.slice(1) : undefined;
        if (!next.curve) delete next.curve;
        return next;
    }

    private scalarValueInput(value: AnimatedValue, path: Array<string | number>, callbacks: InspectorCallbacks): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = primaryCellText(value);
        input.addEventListener('input', () => callbacks.onDirty());
        input.addEventListener('change', () => {
            const next = this.animatedFromPrimaryText(input.value, value);
            callbacks.onFieldEdit(path, next, value.curve ? { reload: true } : undefined);
        });
        return input;
    }

    private animatedFromPrimaryText(text: string, previous: AnimatedValue): AnimatedValue {
        const raw = text.trim() || '0';
        const next = cloneEditableAnimated(previous);
        next.raw = raw;
        next.rawStyle = styleOfInput(raw);
        next.value = isNumericCellText(raw) ? Number(raw.replace(/%$/, '')) : 0;
        return next;
    }

}

export function createDefaultSubsystem(name: string): Subsystem {
    return {
        name,
        maxAmount: 128,
        emitterType: 'point',
        billboard: true,
        duration: makeAnimated(-1),
        life: { a: makeAnimated(0.5), b: makeAnimated(1.5) },
        emission: makeAnimated(24),
        size: makeAnimated(1),
        velocity: makeAnimated(1),
        texture: { file: '', x: 1, y: 1, shader: 'ParticleAdditive' },
        color: {
            r: makeAnimated(255),
            g: makeAnimated(255),
            b: makeAnimated(255),
            alpha: makeAnimated(255),
            keys: { r: 'x', g: 'y', b: 'z', alpha: 'alpha' },
        },
        position: { x: makeAnimated(0), y: makeAnimated(0), z: makeAnimated(0) },
        unknown: [],
        childsystems: [],
        spans: {},
    };
}

export function createDefaultCurve(name: string): AnimationCurve {
    return {
        name,
        start: 0,
        duration: 1,
        repeat: false,
        minValue: 0,
        maxValue: 1,
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        op: 'MUL',
        time: 'life',
        unknown: [],
        spans: {},
    };
}

export function createDefaultForce(name: string): Force {
    return {
        name,
        type: 'planar',
        direction: [0, 1, 0],
        amount: makeAnimated(1),
        unknown: [],
        spans: {},
    };
}

export { scalarNumber, ensureAnimated };
