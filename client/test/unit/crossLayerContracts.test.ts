import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { LOCALISATION_CODES } from '../../extension/diagnosticI18n';
import { VANILLA_CACHE_FILE_NAMES } from '../../extension/gameProfiles';
import { DIAGNOSTIC_ANALYSIS_CATEGORIES } from '../../extension/ai/types';

describe('Cross-Layer Single Source of Truth Contracts (F# <-> TypeScript)', () => {
    const rootDir = path.resolve(__dirname, '../../../');

    describe('LOCALISATION_CODES contract', () => {
        it('matches localisationDiagnosticCodes in DiagnosticMerge.fs', () => {
            const diagMergePath = path.join(rootDir, 'src/Main/DiagnosticMerge.fs');
            expect(fs.existsSync(diagMergePath), `DiagnosticMerge.fs not found at ${diagMergePath}`).to.be.true;

            const content = fs.readFileSync(diagMergePath, 'utf-8');
            const match = content.match(/let\s+private\s+localisationDiagnosticCodes\s*=\s*set\s*\[([\s\S]*?)\]/);
            expect(match, 'Failed to extract localisationDiagnosticCodes from DiagnosticMerge.fs').to.not.be.null;

            const block = match?.[1] ?? '';
            const fsharpCodes = (block.match(/"CW\d+"/g) || []).map(code => code.replace(/"/g, ''));
            const fsharpSet = new Set(fsharpCodes);

            // Assert bidirectional equality
            expect([...LOCALISATION_CODES].sort()).to.deep.equal([...fsharpSet].sort());
        });
    });

    describe('VANILLA_CACHE_FILE_NAMES contract', () => {
        it('matches serialize* cache file names in Serialize.fs', () => {
            const serializePath = path.join(rootDir, 'src/Main/Serialize.fs');
            expect(fs.existsSync(serializePath), `Serialize.fs not found at ${serializePath}`).to.be.true;

            const content = fs.readFileSync(serializePath, 'utf-8');
            const matches = content.matchAll(/let\s+serialize\w+\s*=\s*serializeToCache\s+\S+\s+"([^"]+\.cwb)"/g);
            const fsharpCwbFiles = new Set<string>();
            for (const m of matches) {
                const cwbName = m[1];
                if (cwbName) {
                    fsharpCwbFiles.add(cwbName.toLowerCase());
                }
            }

            const tsCwbFiles = new Set(Object.values(VANILLA_CACHE_FILE_NAMES).map(name => name.toLowerCase()));

            expect([...tsCwbFiles].sort()).to.deep.equal([...fsharpCwbFiles].sort());
        });
    });

    describe('LSP Commands contract', () => {
        it('ensures all command names in Commands.fs are unique and include all AI and query commands', () => {
            const commandsFsPath = path.join(rootDir, 'src/LSP/Commands.fs');
            expect(fs.existsSync(commandsFsPath), `Commands.fs not found at ${commandsFsPath}`).to.be.true;

            const content = fs.readFileSync(commandsFsPath, 'utf-8');
            const matches = content.matchAll(/(?:readCmd|writeCmd)\s+"([^"]+)"/g);
            const commandNames: string[] = [];
            for (const m of matches) {
                const cmd = m[1];
                if (cmd) {
                    commandNames.push(cmd);
                }
            }

            // Check for duplicate command declarations
            const uniqueSet = new Set(commandNames);
            expect(uniqueSet.size, 'Commands.fs should not have duplicate command definitions').to.equal(commandNames.length);

            // Assert required AI commands are declared and announced
            const requiredAiCommands = [
                'cwtools.ai.getScopeAtPosition',
                'cwtools.ai.getCompletionContext',
                'cwtools.ai.queryTypes',
                'cwtools.ai.queryDefinition',
                'cwtools.ai.queryDefinitionByName',
                'cwtools.ai.exploreProject',
                'cwtools.ai.exploreInlineGraph',
                'cwtools.ai.analyzePdxFlow',
                'cwtools.ai.queryLocalisationAudit',
                'cwtools.ai.compareDefinitionWithVanilla',
                'cwtools.ai.queryProjectKnowledgeDb',
                'cwtools.ai.getSemanticCatalog',
                'cwtools.ai.validateOverlay',
                'cwtools.ai.queryScriptedEffects',
                'cwtools.ai.queryScriptedTriggers',
                'cwtools.ai.queryEnums',
                'cwtools.ai.getEntityInfo',
                'cwtools.ai.queryStaticModifiers',
                'cwtools.ai.queryVariables',
                'cwtools.ai.queryOverrideModes',
                'cwtools.ai.getDiagnosticsFresh',
                'cwtools.ai.getAllDiagnostics',
                'cwtools.ai.waitDiagnosticsFresh',
                'cwtools.ai.getValidationStatus',
                'cwtools.ai.revalidateFiles',
                'cwtools.ai.parseFragment',
                'cwtools.ai.shader.symbols',
                'cwtools.ai.shader.compileUnit',
                'cwtools.ai.shader.variants',
                'cwtools.ai.shader.callers',
                'cwtools.ai.shader.reachability',
                'cwtools.ai.shader.validate',
                'cwtools.ai.shader.preflightEdit',
                'cwtools.ai.shader.compareVanilla',
                'cwtools.ai.exportProjectKnowledge',
            ];

            for (const cmd of requiredAiCommands) {
                expect(uniqueSet.has(cmd), `Expected ${cmd} to be registered in Commands.fs`).to.be.true;
            }
        });
    });

    describe('Diagnostic categories contract', () => {
        it('ensures all categories returned by F# diagnosticCategoryAndHint are present in TS DIAGNOSTIC_ANALYSIS_CATEGORIES', () => {
            const programFsPath = path.join(rootDir, 'src/Main/Program.fs');
            expect(fs.existsSync(programFsPath), `Program.fs not found at ${programFsPath}`).to.be.true;

            const content = fs.readFileSync(programFsPath, 'utf-8');
            // Extract diagnosticCategoryAndHint function body
            const funcMatch = content.match(/let\s+diagnosticCategoryAndHint[\s\S]*?else\s*\n\s*"([^"]+)",/);
            expect(funcMatch, 'Could not locate diagnosticCategoryAndHint in Program.fs').to.not.be.null;

            const categoryMatches = content.matchAll(/"([a-z_]+)",\s*\n\s*"[A-Z][^"]*"/g);
            const fsharpCategories = new Set<string>();
            for (const m of categoryMatches) {
                const cat = m[1];
                // Filter to only those matching diagnostic routing categories
                if (cat && (cat.includes('_') || cat === 'unknown')) {
                    fsharpCategories.add(cat);
                }
            }

            const tsCategories = new Set<string>(DIAGNOSTIC_ANALYSIS_CATEGORIES);

            // Every category produced by the F# server must be accepted by TypeScript
            for (const cat of fsharpCategories) {
                expect(tsCategories.has(cat), `F# diagnostic category "${cat}" is missing in TypeScript DIAGNOSTIC_ANALYSIS_CATEGORIES`).to.be.true;
            }
        });
    });
});
