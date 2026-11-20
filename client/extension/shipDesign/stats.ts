import type { ShipDesignData, ShipDesignStatsData, ShipDesignStatValue } from '../../shared/shipDesignProtocol';
import type { DefinitionNumber } from './definitionNodes';
import {
    lookupShipDesignComponent,
    lookupShipDesignSection,
    type ShipDesignCatalog,
    type ShipDesignDamageData,
    type ShipDesignResourceData,
} from './definitions';
import { buildShipDesignSectionSlots } from './slots';

function compareKeys(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

class StatAccumulator {
    private value: number | undefined;
    private readonly sources = new Set<string>();
    private readonly unresolved = new Set<string>();

    constructor(private readonly combine = (a: number, b: number): number => a + b) {}

    add(source: string, entry: DefinitionNumber | undefined): void {
        if (!entry) return;
        const { value, raw } = entry;
        if (value === undefined || !Number.isFinite(value)) {
            this.addUnresolved(source, raw);
            return;
        }
        const combined = this.value === undefined ? value : this.combine(this.value, value);
        if (!Number.isFinite(combined)) {
            this.addUnresolved(source, raw);
            return;
        }
        this.sources.add(source);
        this.value = combined;
    }

    addUnresolved(source: string, raw: string): void {
        this.sources.add(source);
        this.unresolved.add(raw);
    }

    result(): ShipDesignStatValue {
        return {
            status: this.value === undefined ? 'unknown' : this.unresolved.size ? 'partial' : 'known',
            ...(this.value === undefined ? {} : { value: this.value }),
            sources: [...this.sources].sort(compareKeys),
            unresolved: [...this.unresolved].sort(compareKeys),
        };
    }
}

function addDamage(stat: StatAccumulator, source: string, damage: ShipDesignDamageData): void {
    function requiredNumber(field: string, entry?: DefinitionNumber): number | undefined {
        if (entry?.value !== undefined && Number.isFinite(entry.value)) return entry.value;
        stat.addUnresolved(source, entry?.raw ?? 'damage_per_day.' + field + ' (missing)');
        return undefined;
    }

    const min = requiredNumber('damage.min', damage.min);
    const max = requiredNumber('damage.max', damage.max);
    const accuracy = requiredNumber('accuracy', damage.accuracy);
    if (min !== undefined && max !== undefined && accuracy !== undefined) {
        stat.add(source, {
            raw: 'damage_per_day (' + source + ')',
            value: (min / 2 + max / 2) * accuracy,
        });
    }
}

/** Aggregate direct static design values from the catalog. */
export function computeShipDesignStats(catalog: ShipDesignCatalog, design: ShipDesignData): ShipDesignStatsData {
    const values = {
        buildTime: new StatAccumulator(),
        hull: new StatAccumulator(),
        armor: new StatAccumulator(),
        shields: new StatAccumulator(),
        evasion: new StatAccumulator(),
        speed: new StatAccumulator(),
        power: new StatAccumulator(),
        sensorRange: new StatAccumulator(Math.max),
        damagePerDay: new StatAccumulator(),
    };
    const modifiers = new Map([
        ['ship_hull_add', values.hull],
        ['ship_armor_add', values.armor],
        ['ship_shield_add', values.shields],
        ['ship_evasion_add', values.evasion],
        ['ship_speed_add', values.speed],
    ]);
    const resources = new Map<string, StatAccumulator>();

    function addModifiers(source: string, fields: Record<string, DefinitionNumber>): void {
        for (const name of Object.keys(fields).sort(compareKeys)) {
            modifiers.get(name.toLowerCase())?.add(source, fields[name]);
        }
    }

    function addResources(source: string, data: ShipDesignResourceData | undefined): void {
        if (!data) return;
        for (const kind of ['cost', 'upkeep'] as const) {
            const entries = data[kind];
            for (const name of Object.keys(entries).sort(compareKeys)) {
                const key = kind + '.' + name.toLowerCase();
                let stat = resources.get(key);
                if (!stat) {
                    stat = new StatAccumulator();
                    resources.set(key, stat);
                }
                stat.add(source, entries[name]);
            }
        }
    }

    const size = catalog.shipSizeDetails.get(design.shipSize?.toLowerCase() ?? '');
    if (size) {
        const source = 'size:' + size.key;
        values.buildTime.add(source, size.baseBuildtime);
        values.hull.add(source, size.maxHitpoints);
        values.speed.add(source, size.maxSpeed);
        addModifiers(source, size.modifier);
        addModifiers(source, size.shipModifier);
        addResources(source, size.resources);
    }

    const componentKeys = [...design.requiredComponents];
    const sections = [...design.sections].sort((a, b) => compareKeys(a.template, b.template));
    for (const section of sections) {
        const definition = lookupShipDesignSection(catalog, section.template);
        if (!definition) continue;
        const source = 'section:' + definition.key;
        addModifiers(source, definition.modifier);
        addModifiers(source, definition.shipModifier);
        addResources(source, definition.resources);
        for (const slot of buildShipDesignSectionSlots(catalog, design, section)) {
            if (slot.selected) componentKeys.push(slot.selected);
        }
    }

    // Count each equipped occurrence, while listing each contributing definition once in provenance.
    for (const key of componentKeys.sort(compareKeys)) {
        const component = lookupShipDesignComponent(catalog, key);
        if (!component) continue;
        const source = 'component:' + component.key;
        addResources(source, component.resources);
        addModifiers(source, component.modifier);
        addModifiers(source, component.shipModifier);
        values.buildTime.add(source, component.buildTime);
        values.power.add(source, component.power);
        values.sensorRange.add(source, component.sensorRange);
        if (component.kind === 'weapon' && component.damage) addDamage(values.damagePerDay, source, component.damage);
    }

    return {
        designId: design.id,
        values: Object.fromEntries(Object.entries(values).map(([name, stat]) => [name, stat.result()])),
        resources: Object.fromEntries([...resources]
            .sort(([a], [b]) => compareKeys(a, b))
            .map(([key, stat]) => [key, stat.result()])),
    };
}
