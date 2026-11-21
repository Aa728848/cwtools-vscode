/**
 * Ship Design Auto-Loadout Draft Generator.
 *
 * Deterministically synthesizes section choices, required components, and
 * utility/weapon loadouts subject to technology scope, role preference,
 * upgrade-chain depth, and bounded power-balance repair passes.
 */

import type {
    ShipDesignData,
    ShipDesignGenerateOptions,
    ShipDesignLoadoutSection,
    ShipDesignSectionData,
    ShipDesignSlotData,
    ShipDesignTechnologyScope,
} from '../../shared/shipDesignProtocol';
import {
    lookupShipDesignComponent,
    lookupShipSizeInfo,
    type ShipDesignCatalog,
    type ShipDesignComponentDefinition,
    type ShipDesignSectionDefinition,
} from './definitions';
import {
    buildShipDesignSectionSlots,
    shipDesignComponentCandidates,
    shipDesignSectionCandidates,
} from './slots';

export interface ShipDesignDraftResult {
    sections: ShipDesignLoadoutSection[];
    requiredComponents: string[];
    explanations: string[];
    warnings: string[];
}

/** Picks the English or Chinese copy; the Host supplies one bound to the VS Code display language. */
export type ShipDesignText = (en: string, zh: string) => string;
const englishText: ShipDesignText = en => en;

interface TechnologyFilter {
    allows(prerequisites: readonly string[]): boolean;
    describe(): string;
}

const MAX_UPGRADE_DEPTH = 32;
const MAX_POWER_REPAIRS = 64;

function key(value: string): string {
    return value.toLowerCase();
}

function includes(values: readonly string[], value: string | undefined): boolean {
    return value !== undefined && values.some(candidate => key(candidate) === key(value));
}

function compareNames(left: string, right: string): number {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function technologyFilter(catalog: ShipDesignCatalog, scope: ShipDesignTechnologyScope, text: ShipDesignText): TechnologyFilter {
    if (scope.kind === 'all') return {
        allows: () => true,
        describe: () => text('all technologies', '全部科技'),
    };
    const available = new Set<string>();
    if (scope.kind === 'starting') {
        for (const [id, technology] of catalog.technologies) {
            if (technology.isStartTech) available.add(id);
        }
    } else {
        const queue = [...scope.technologies];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            const folded = key(current);
            if (available.has(folded)) continue;
            available.add(folded);
            for (const prerequisite of catalog.technologyPrerequisites.get(folded) ?? []) queue.push(prerequisite);
        }
    }
    return {
        allows: prerequisites => prerequisites.every(prerequisite => available.has(key(prerequisite))),
        describe: () => scope.kind === 'starting'
            ? text('starting technologies (', '初始科技（') + available.size + text(')', '）')
            : text('custom technologies with prerequisite closure (', '自定义科技及其前置（') + available.size + text(')', '）'),
    };
}

function componentTier(catalog: ShipDesignCatalog, component: ShipDesignComponentDefinition): number {
    let tier = 0;
    for (const prerequisite of component.prerequisites) {
        tier = Math.max(tier, catalog.technologies.get(key(prerequisite))?.tier ?? 0);
    }
    return tier;
}

function componentScore(
    catalog: ShipDesignCatalog,
    component: ShipDesignComponentDefinition,
    role: string,
): number {
    return (role && includes(component.aiTags, role) ? 100000 : 0)
        + componentTier(catalog, component) * 1000
        + component.aiWeight.base * 10
        + component.aiTagWeight;
}

function sectionScore(section: ShipDesignSectionDefinition, role: string): number {
    return (role && includes(section.aiTags, role) ? 100000 : 0) + section.aiWeight.base;
}

function terminalUpgrades(
    candidates: readonly ShipDesignComponentDefinition[],
    warnings: string[],
    text: ShipDesignText,
): ShipDesignComponentDefinition[] {
    const byKey = new Map(candidates.map(candidate => [key(candidate.key), candidate]));
    const terminals = new Map<string, ShipDesignComponentDefinition>();
    for (const candidate of candidates) {
        let current = candidate;
        const seen = new Set<string>();
        for (let depth = 0; depth < MAX_UPGRADE_DEPTH; depth++) {
            const folded = key(current.key);
            if (seen.has(folded)) {
                warnings.push(text('Upgrade cycle detected at ', '在 ') + current.key
                    + text('; using the last unique component.', ' 处检测到升级循环，使用最后一个不重复的部件。'));
                break;
            }
            seen.add(folded);
            const next = current.upgradesTo ? byKey.get(key(current.upgradesTo)) : undefined;
            if (!next) break;
            current = next;
        }
        terminals.set(key(current.key), current);
    }
    return [...terminals.values()];
}

function chooseComponent(
    catalog: ShipDesignCatalog,
    candidates: readonly ShipDesignComponentDefinition[],
    role: string,
    explanations: string[],
    warnings: string[],
    context: string,
    text: ShipDesignText,
): ShipDesignComponentDefinition | undefined {
    const staticallyUsable = candidates.filter(component => component.shouldAiUse);
    const withoutDynamic = staticallyUsable.filter(component => !component.dynamicPotential);
    const pool = withoutDynamic.length > 0 ? withoutDynamic : staticallyUsable;
    if (withoutDynamic.length === 0 && staticallyUsable.some(component => component.dynamicPotential)) {
        warnings.push(context + text(': runtime potential/valid_for_country conditions were not evaluated.', '：未评估运行时的 potential/valid_for_country 条件。'));
    }
    const terminals = terminalUpgrades(pool, warnings, text);
    const sorted = terminals.sort((left, right) => {
        const score = componentScore(catalog, right, role) - componentScore(catalog, left, role);
        return score || compareNames(left.key, right.key);
    });
    const selected = sorted[0];
    if (selected) {
        explanations.push(context + text(': selected ', '：选择 ') + selected.key + text(' (score ', '（评分 ')
            + componentScore(catalog, selected, role) + text(').', '）。'));
        if (selected.aiWeight.dynamic) {
            warnings.push(context + text(': conditional ai_weight on ', '：') + selected.key
                + text(' was reduced to its static base ', ' 的条件 ai_weight 已按静态基础值计算：') + selected.aiWeight.base + text('.', '。'));
        }
    }
    return selected;
}

function pseudoSection(design: ShipDesignData, section: ShipDesignLoadoutSection, occurrence: number): ShipDesignSectionData {
    return {
        id: design.id + '/section:' + occurrence,
        designId: design.id,
        occurrence,
        slot: section.slot,
        template: section.template,
        components: [],
        source: design.source,
    };
}

function synchronizeComponents(
    working: ShipDesignData,
    sectionId: string,
    slot: ShipDesignSlotData,
    componentKey: string,
): void {
    const section = working.sections.find(candidate => candidate.id === sectionId);
    if (!section) return;
    const existing = section.components.find(component => key(component.slot) === key(slot.name));
    if (existing) existing.template = componentKey;
    else section.components.push({
        id: sectionId + '/component:' + section.components.length,
        slot: slot.name,
        template: componentKey,
        source: section.source,
    });
}

function powerTotal(
    catalog: ShipDesignCatalog,
    working: ShipDesignData,
    requiredComponents: readonly string[],
): { total: number; unresolved: string[] } {
    const keys = [
        ...working.sections.flatMap(section => section.components.map(component => component.template)),
        ...requiredComponents,
    ];
    let total = 0;
    const unresolved: string[] = [];
    for (const componentKey of keys) {
        const component = lookupShipDesignComponent(catalog, componentKey);
        if (!component?.power) continue;
        if (component.power.value === undefined) unresolved.push(component.key + ':' + component.power.raw);
        else total += component.power.value;
    }
    return { total, unresolved };
}

function repairPower(
    catalog: ShipDesignCatalog,
    working: ShipDesignData,
    requiredComponents: string[],
    role: string,
    explanations: string[],
    warnings: string[],
    technology: TechnologyFilter,
    text: ShipDesignText,
): void {
    const initial = powerTotal(catalog, working, requiredComponents);
    if (initial.total >= 0) return;
    const shipInfo = lookupShipSizeInfo(catalog, working.shipSize ?? '');
    const reactorCandidates = [...catalog.components.values()].filter(component =>
        component.power && (component.power.value ?? 0) > 0
        && technology.allows(component.prerequisites)
        && component.shouldAiUse
        && !component.hidden
        && (component.classRestrictions.length === 0 || includes(component.classRestrictions, shipInfo?.shipClass))
        && (component.sizeRestrictions.length === 0 || includes(component.sizeRestrictions, working.shipSize)));
    const currentReactorIndex = requiredComponents.findIndex(componentKey =>
        (lookupShipDesignComponent(catalog, componentKey)?.power?.value ?? 0) > 0);
    const currentReactor = currentReactorIndex >= 0
        ? lookupShipDesignComponent(catalog, requiredComponents[currentReactorIndex] ?? '')
        : undefined;
    if (currentReactor?.componentSet) {
        const alternatives = reactorCandidates.filter(component =>
            key(component.componentSet ?? '') === key(currentReactor.componentSet ?? '')
            && (component.power?.value ?? 0) > (currentReactor.power?.value ?? 0));
        alternatives.sort((left, right) => (right.power?.value ?? 0) - (left.power?.value ?? 0)
            || compareNames(left.key, right.key));
        const reactor = alternatives[0];
        if (reactor) {
            requiredComponents[currentReactorIndex] = reactor.key;
            explanations.push(text('Power repair: replaced ', '能量修复：将 ') + currentReactor.key + text(' with ', ' 替换为 ') + reactor.key + text('.', '。'));
        }
    }

    for (let repair = 0; repair < MAX_POWER_REPAIRS; repair++) {
        if (powerTotal(catalog, working, requiredComponents).total >= 0) break;
        let best: {
            sectionId: string;
            slot: ShipDesignSlotData;
            component: ShipDesignComponentDefinition;
            gain: number;
        } | undefined;
        for (const section of working.sections) {
            for (const slot of buildShipDesignSectionSlots(catalog, working, section)) {
                if (!slot.selected) continue;
                const current = lookupShipDesignComponent(catalog, slot.selected);
                const currentPower = current?.power?.value ?? 0;
                const candidates = shipDesignComponentCandidates(catalog, working, slot)
                    .map(candidate => candidate.component)
                    .filter(component => technology.allows(component.prerequisites)
                        && (component.power?.value ?? 0) > currentPower);
                const alternative = chooseQuietly(catalog, candidates, role);
                if (!alternative) continue;
                const gain = (alternative.power?.value ?? 0) - currentPower;
                if (!best || gain > best.gain) best = { sectionId: section.id, slot, component: alternative, gain };
            }
        }
        if (!best || best.gain <= 0) break;
        synchronizeComponents(working, best.sectionId, best.slot, best.component.key);
        explanations.push(text('Power repair: selected ', '能量修复：选择 ') + best.component.key + text(' in ', '，位于 ') + best.slot.name + text('.', '。'));
    }
    const final = powerTotal(catalog, working, requiredComponents);
    if (final.total < 0) warnings.push(text('Power remains negative after bounded repair: ', '有限次修复后能量仍为负：') + final.total + text('.', '。'));
    for (const raw of final.unresolved) warnings.push(text('Unresolved power value ', '未解析的能量值 ') + raw + text('.', '。'));
}

function chooseQuietly(
    catalog: ShipDesignCatalog,
    candidates: readonly ShipDesignComponentDefinition[],
    role: string,
): ShipDesignComponentDefinition | undefined {
    const terminals = terminalUpgrades(candidates.filter(component => component.shouldAiUse), [], englishText);
    return terminals.sort((left, right) => componentScore(catalog, right, role) - componentScore(catalog, left, role)
        || compareNames(left.key, right.key))[0];
}

export function generateShipDesignDraft(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    options: ShipDesignGenerateOptions,
    text: ShipDesignText = englishText,
): ShipDesignDraftResult {
    const explanations: string[] = [];
    const warnings: string[] = [];
    const sections: ShipDesignLoadoutSection[] = [];
    const requiredComponents: string[] = [];
    const shipSize = design.shipSize ?? '';
    const shipInfo = lookupShipSizeInfo(catalog, shipSize);
    const details = catalog.shipSizeDetails.get(key(shipSize));
    if (!shipInfo || !details) {
        return { sections, requiredComponents, explanations, warnings: [text('Cannot generate without a known ship size.', '船型未知，无法生成。')] };
    }
    if (design.loadoutReadOnlyReason) {
        return { sections, requiredComponents, explanations, warnings: [text(design.loadoutReadOnlyReason, '含成长阶段的配装为只读，无法生成。')] };
    }
    const technology = technologyFilter(catalog, options.technology, text);
    explanations.push(text('Generating role ', '生成角色 ') + (options.role || text('(unspecified)', '（未指定）'))
        + text(' with ', '，范围：') + technology.describe() + text('.', '。'));

    for (const sectionSlot of shipInfo.sectionSlots) {
        const candidates = shipDesignSectionCandidates(catalog, shipSize, sectionSlot.slot)
            .map(candidate => candidate.section)
            .filter(section => technology.allows(section.prerequisites));
        const sorted = candidates.sort((left, right) => sectionScore(right, options.role) - sectionScore(left, options.role)
            || compareNames(left.key, right.key));
        const selected = sorted[0];
        if (!selected) {
            warnings.push(text('No section candidate for ', '在所选科技范围内，分段槽位 ') + sectionSlot.slot
                + text(' under the selected technology scope.', ' 没有可用的分段。'));
            continue;
        }
        sections.push({ slot: sectionSlot.slot, template: selected.key, components: [] });
        explanations.push(text('Section ', '分段 ') + sectionSlot.slot + text(': selected ', '：选择 ') + selected.key + text('.', '。'));
        if (selected.aiWeight.dynamic) {
            warnings.push(text('Section ', '分段 ') + selected.key + text(' has conditional ai_weight; static base used.', ' 含条件 ai_weight，已使用静态基础值。'));
        }
    }

    const working: ShipDesignData = {
        ...design,
        sections: sections.map((section, index) => pseudoSection(design, section, index)),
        requiredComponents: [],
    };
    for (const section of working.sections) {
        for (const slot of buildShipDesignSectionSlots(catalog, working, section)) {
            const candidates = shipDesignComponentCandidates(catalog, working, slot)
                .map(candidate => candidate.component)
                .filter(component => technology.allows(component.prerequisites));
            const selected = chooseComponent(catalog, candidates, options.role, explanations, warnings, slot.name, text);
            if (!selected) {
                warnings.push(text('No component candidate for ', '槽位 ') + slot.name + text('; leaving it empty.', ' 没有可用部件，保持为空。'));
                continue;
            }
            synchronizeComponents(working, section.id, slot, selected.key);
        }
    }

    const requiredSets = details.requiredComponentSets;
    const preserved = design.requiredComponents.filter(componentKey => {
        const component = lookupShipDesignComponent(catalog, componentKey);
        return component?.componentSet && !includes(requiredSets, component.componentSet);
    });
    requiredComponents.push(...preserved);
    for (const set of requiredSets) {
        const candidates = [...catalog.components.values()].filter(component =>
            key(component.componentSet ?? '') === key(set)
            && technology.allows(component.prerequisites)
            && !component.hidden
            && (component.classRestrictions.length === 0 || includes(component.classRestrictions, shipInfo.shipClass))
            && (component.sizeRestrictions.length === 0 || includes(component.sizeRestrictions, shipSize)));
        const selected = chooseComponent(catalog, candidates, options.role, explanations, warnings, text('Required set ', '必需集合 ') + set, text);
        if (selected) requiredComponents.push(selected.key);
        else {
            const existing = design.requiredComponents.find(componentKey =>
                key(lookupShipDesignComponent(catalog, componentKey)?.componentSet ?? '') === key(set));
            if (existing) {
                requiredComponents.push(existing);
                warnings.push(text('Required set ', '必需集合 ') + set + text(': preserved existing ', '：没有符合条件的替代，保留原有 ') + existing
                    + text(' because no replacement was eligible.', '。'));
            } else warnings.push(text('Required set ', '必需集合 ') + set + text(' could not be filled.', ' 无法填充。'));
        }
    }

    sections.splice(0, sections.length, ...working.sections.map(section => ({
        slot: section.slot,
        template: section.template,
        components: section.components.map(component => ({ slot: component.slot, template: component.template })),
    })));
    if (options.enforcePower) repairPower(catalog, working, requiredComponents, options.role, explanations, warnings, technology, text);
    sections.splice(0, sections.length, ...working.sections.map(section => ({
        slot: section.slot,
        template: section.template,
        components: section.components.map(component => ({ slot: component.slot, template: component.template })),
    })));
    return { sections, requiredComponents, explanations, warnings };
}
