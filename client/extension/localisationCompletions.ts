import { parseLocalisationLine } from './indexing/locParser';

export type LocalisationCompletionKind =
	| 'colorMarker'
	| 'colorArgument'
	| 'icon'
	| 'command'
	| 'reference';

export interface LocalisationCompletionContext {
	kind: LocalisationCompletionKind;
	prefix: string;
	replaceStart: number;
	replaceEnd: number;
}

export interface LocalisationCompletionCandidate {
	label: string;
	insertText: string;
	detail: string;
	documentation?: string;
}

export interface LocalisationCommandCandidate extends LocalisationCompletionCandidate {
	snippet?: boolean;
}

export const LOCALISATION_COLOR_COMPLETIONS: LocalisationCompletionCandidate[] = [
	{ label: '§Y Yellow', insertText: 'Y', detail: 'Localisation color', documentation: 'Yellow emphasis, commonly used for values and names.' },
	{ label: '§H Header', insertText: 'H', detail: 'Localisation color', documentation: 'Header/gold emphasis.' },
	{ label: '§G Green', insertText: 'G', detail: 'Localisation color', documentation: 'Positive or available state.' },
	{ label: '§R Red', insertText: 'R', detail: 'Localisation color', documentation: 'Negative, blocked, or warning state.' },
	{ label: '§B Blue', insertText: 'B', detail: 'Localisation color', documentation: 'Blue emphasis.' },
	{ label: '§E Cyan', insertText: 'E', detail: 'Localisation color', documentation: 'Cyan/teal emphasis.' },
	{ label: '§W White', insertText: 'W', detail: 'Localisation color', documentation: 'White emphasis.' },
	{ label: '§L Muted', insertText: 'L', detail: 'Localisation color', documentation: 'Muted long-form description text.' },
	{ label: '§T Tan', insertText: 'T', detail: 'Localisation color', documentation: 'Tan/gray emphasis.' },
	{ label: '§S Soft Green', insertText: 'S', detail: 'Localisation color', documentation: 'Soft green emphasis.' },
	{ label: '§P Pink', insertText: 'P', detail: 'Localisation color', documentation: 'Pink emphasis.' },
	{ label: '§M Magenta', insertText: 'M', detail: 'Localisation color', documentation: 'Magenta emphasis.' },
	{ label: '§O Orange', insertText: 'O', detail: 'Localisation color', documentation: 'Orange emphasis.' },
	{ label: '§C Cyan Alt', insertText: 'C', detail: 'Localisation color', documentation: 'Alternate cyan emphasis.' },
	{ label: '§K Dark', insertText: 'K', detail: 'Localisation color', documentation: 'Dark/disabled emphasis.' },
	{ label: '§r Purple', insertText: 'r', detail: 'Localisation color', documentation: 'Purple emphasis.' },
	{ label: '§! Reset', insertText: '!', detail: 'Localisation color', documentation: 'Ends the current colored span.' },
];

export const LOCALISATION_ICON_COMPLETIONS: LocalisationCompletionCandidate[] = [
	'energy',
	'minerals',
	'food',
	'influence',
	'unity',
	'physics',
	'society',
	'engineering',
	'consumer_goods',
	'alloys',
	'volatile_motes',
	'exotic_gases',
	'rare_crystals',
	'minor_artifacts',
	'astral_threads',
	'nanites',
	'dark_matter',
	'zro',
	'living_metal',
	'pop',
	'pops',
	'happiness',
	'amenities',
	'crime',
	'stability',
	'empire_sprawl',
	'navy_size',
	'fleet_template_size',
	'military_power',
	'military_power_boss',
	'army_power',
	'planetsize',
	'leader_skill',
	'anomaly_level',
	'risk',
	'time',
	'trigger_yes',
	'trigger_no',
	'science_ship',
	'construction_ship',
	'colony_ship',
	'military_ship',
	'army_ship',
	'building',
	'blocker',
	'empire_modifier',
	'planet_modifier',
	'pop_modifier',
	'ship_modifier',
	'ship_stats_hitpoints',
	'ship_stats_armor',
	'ship_stats_shield',
	'ship_stats_damage',
	'ship_stats_evasion',
	'ship_stats_speed',
	'ship_stats_power',
	'ship_stats_build_cost',
	'ship_stats_build_time',
	'ship_stats_maintenance',
	'ship_stats_special',
	'ctrl',
	'shift',
	'alt',
	'escape',
	'space',
].map(name => ({
	label: `£${name}£`,
	insertText: `£${name}£`,
	detail: 'Localisation icon',
}));

export const LOCALISATION_COMMAND_COMPLETIONS: LocalisationCommandCandidate[] = [
	{ label: '[Root.GetName]', insertText: '[Root.GetName]', detail: 'Localisation command', documentation: 'Current root scope name.' },
	{ label: '[Root.GetNamePlural]', insertText: '[Root.GetNamePlural]', detail: 'Localisation command', documentation: 'Current root scope plural name.' },
	{ label: '[Root.GetSpeciesName]', insertText: '[Root.GetSpeciesName]', detail: 'Localisation command', documentation: 'Root country/species name where available.' },
	{ label: '[Root.GetSpeciesNamePlural]', insertText: '[Root.GetSpeciesNamePlural]', detail: 'Localisation command', documentation: 'Root species plural name where available.' },
	{ label: '[Root.GetSpeciesAdj]', insertText: '[Root.GetSpeciesAdj]', detail: 'Localisation command', documentation: 'Root species adjective where available.' },
	{ label: '[Root.GetRulerName]', insertText: '[Root.GetRulerName]', detail: 'Localisation command', documentation: 'Root ruler name where available.' },
	{ label: '[Root.GetRulerTitle]', insertText: '[Root.GetRulerTitle]', detail: 'Localisation command', documentation: 'Root ruler title where available.' },
	{ label: '[Root.GetLeaderName]', insertText: '[Root.GetLeaderName]', detail: 'Localisation command', documentation: 'Root leader name where available.' },
	{ label: '[Root.Capital.GetName]', insertText: '[Root.Capital.GetName]', detail: 'Localisation command', documentation: 'Root capital name.' },
	{ label: '[Root.Owner.GetName]', insertText: '[Root.Owner.GetName]', detail: 'Localisation command', documentation: 'Owner name for owned scopes.' },
	{ label: '[From.GetName]', insertText: '[From.GetName]', detail: 'Localisation command', documentation: 'Name of the From scope.' },
	{ label: '[From.From.GetName]', insertText: '[From.From.GetName]', detail: 'Localisation command', documentation: 'Name of the nested From scope.' },
	{ label: '[This.GetName]', insertText: '[This.GetName]', detail: 'Localisation command', documentation: 'Name of the current This scope.' },
	{ label: '[Prev.GetName]', insertText: '[Prev.GetName]', detail: 'Localisation command', documentation: 'Name of the previous scope.' },
	{ label: '[Owner.GetName]', insertText: '[Owner.GetName]', detail: 'Localisation command', documentation: 'Owner scope name.' },
	{ label: '[Leader.GetName]', insertText: '[Leader.GetName]', detail: 'Localisation command', documentation: 'Leader scope name.' },
	{ label: '[Root.GetSheHe]', insertText: '[Root.GetSheHe]', detail: 'Localisation command', documentation: 'Root pronoun where available.' },
	{ label: '[Root.GetHerHis]', insertText: '[Root.GetHerHis]', detail: 'Localisation command', documentation: 'Root possessive pronoun where available.' },
	{ label: '[Root.GetHimHer]', insertText: '[Root.GetHimHer]', detail: 'Localisation command', documentation: 'Root object pronoun where available.' },
	{ label: '[Root.GetPlanetMoon]', insertText: '[Root.GetPlanetMoon]', detail: 'Localisation command', documentation: 'Planet/moon wording where available.' },
	{ label: '[event_target:target.GetName]', insertText: '[event_target:${1:target}.GetName]', detail: 'Localisation command', documentation: 'Named event target. Replace target with the real event target name.', snippet: true },
	{ label: '[event_target:target.Owner.GetName]', insertText: '[event_target:${1:target}.Owner.GetName]', detail: 'Localisation command', documentation: 'Owner name from a named event target.', snippet: true },
];

function contextFromDollar(valueBefore: string, valueStart: number, character: number): LocalisationCompletionContext | undefined {
	const dollarStart = valueBefore.lastIndexOf('$');
	if (dollarStart < 0) return undefined;

	const fragment = valueBefore.slice(dollarStart + 1);
	if (fragment.includes('$')) return undefined;

	const pipeStart = fragment.lastIndexOf('|');
	if (pipeStart >= 0) {
		const colorPrefix = fragment.slice(pipeStart + 1);
		if (/^[A-Za-z0-9!%-]*$/.test(colorPrefix)) {
			return {
				kind: 'colorArgument',
				prefix: colorPrefix,
				replaceStart: valueStart + dollarStart + 1 + pipeStart + 1,
				replaceEnd: character,
			};
		}
	}

	if (/^[A-Za-z0-9_.:-]*$/.test(fragment)) {
		return {
			kind: 'reference',
			prefix: fragment,
			replaceStart: valueStart + dollarStart,
			replaceEnd: character,
		};
	}

	return undefined;
}

function contextFromBracket(valueBefore: string, valueStart: number, character: number): LocalisationCompletionContext | undefined {
	const bracketStart = valueBefore.lastIndexOf('[');
	if (bracketStart < 0 || bracketStart < valueBefore.lastIndexOf(']')) return undefined;

	const fragment = valueBefore.slice(bracketStart + 1);
	const pipeStart = fragment.lastIndexOf('|');
	if (pipeStart >= 0) {
		const colorPrefix = fragment.slice(pipeStart + 1);
		if (/^[A-Za-z0-9!%-]*$/.test(colorPrefix)) {
			return {
				kind: 'colorArgument',
				prefix: colorPrefix,
				replaceStart: valueStart + bracketStart + 1 + pipeStart + 1,
				replaceEnd: character,
			};
		}
	}

	if (/^[A-Za-z0-9_.:-]*$/.test(fragment)) {
		return {
			kind: 'command',
			prefix: fragment,
			replaceStart: valueStart + bracketStart,
			replaceEnd: character,
		};
	}

	return undefined;
}

export function getLocalisationCompletionContext(line: string, character: number): LocalisationCompletionContext | undefined {
	const cleanLine = line.replace(/\r$/, '');
	const parsed = parseLocalisationLine(cleanLine);
	if (!parsed || character < parsed.valueStart || character > parsed.valueEnd) return undefined;

	const valueBefore = cleanLine.slice(parsed.valueStart, character);

	const colorMatch = valueBefore.match(/\u00a7([A-Za-z0-9!%-]*)$/);
	if (colorMatch) {
		return {
			kind: 'colorMarker',
			prefix: colorMatch[1] ?? '',
			replaceStart: character - colorMatch[0].length,
			replaceEnd: character,
		};
	}

	const iconMatch = valueBefore.match(/\u00a3([A-Za-z0-9_.-]*)$/);
	if (iconMatch) {
		return {
			kind: 'icon',
			prefix: iconMatch[1] ?? '',
			replaceStart: character - iconMatch[0].length,
			replaceEnd: character,
		};
	}

	const dollarContext = contextFromDollar(valueBefore, parsed.valueStart, character);
	if (dollarContext) return dollarContext;

	const bracketContext = contextFromBracket(valueBefore, parsed.valueStart, character);
	if (bracketContext) return bracketContext;

	return undefined;
}
