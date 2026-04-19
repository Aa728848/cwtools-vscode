/**
 * Solar System Preview Panel - manages the webview for solar system visualization.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { parseSolarSystemFile, resolveValue, type SolarSystem, type CelestialBody, type ValueOrRange } from './solarSystemParser';

export class SolarSystemPanel {
    public static currentPanel: SolarSystemPanel | undefined;
    private static readonly viewType = 'cwtools-solar-system-preview';
    private static _outputChannel: vscode.OutputChannel;
    private static _getLog(): vscode.OutputChannel {
        if (!SolarSystemPanel._outputChannel) {
            SolarSystemPanel._outputChannel = vscode.window.createOutputChannel('Solar System Debug');
        }
        return SolarSystemPanel._outputChannel;
    }
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _webviewRootPath: string;
    private _document: vscode.TextDocument | undefined;
    private _skipNextReload = false;
    private _contentSnapshots: string[] = [];
    private _lastSnapshotTime = 0;
    private _messageQueue: Promise<void> = Promise.resolve();

    public static async create(extensionPath: string, document: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (SolarSystemPanel.currentPanel) SolarSystemPanel.currentPanel.dispose();

        const panel = new SolarSystemPanel(extensionPath, column || vscode.ViewColumn.Beside, document);
        SolarSystemPanel.currentPanel = panel;
        await panel._loadAndRender(document);
    }

    private constructor(extensionPath: string, column: vscode.ViewColumn, document: vscode.TextDocument) {
        this._webviewRootPath = path.join(extensionPath, 'bin/client/webview');
        this._document = document;

        const localResourceRoots: vscode.Uri[] = [vscode.Uri.file(this._webviewRootPath)];

        this._panel = vscode.window.createWebviewPanel(
            SolarSystemPanel.viewType,
            `Solar System: ${path.basename(document.fileName)}`,
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots },
        );

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._disposables.push(
            this._panel.webview.onDidReceiveMessage(async msg => {
                switch (msg.command) {
                    case 'goToLine': {
                        const ed = await vscode.window.showTextDocument(document.uri, { viewColumn: vscode.ViewColumn.One });
                        const range = new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);
                        ed.selection = new vscode.Selection(range.start, range.start);
                        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        break;
                    }
                    case 'updateProperty':
                        this._messageQueue = this._messageQueue.then(() => this._handleUpdateProperty(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR updateProperty: ${e}`));
                        break;
                    case 'updateOrbit':
                        this._messageQueue = this._messageQueue.then(() => this._handleUpdateOrbit(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR updateOrbit: ${e}`));
                        break;
                    case 'movePlanetOrbit':
                        this._messageQueue = this._messageQueue.then(() => this._handleMovePlanetOrbit(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR movePlanetOrbit: ${e}`));
                        break;
                    case 'addPlanet':
                        this._messageQueue = this._messageQueue.then(() => this._handleAddPlanet(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR addPlanet: ${e}`));
                        break;
                    case 'deletePlanet':
                        this._messageQueue = this._messageQueue.then(() => this._handleDeletePlanet(msg)).catch(e => SolarSystemPanel._getLog().appendLine(`ERR deletePlanet: ${e}`));
                        break;
                    case 'vscodeUndo':
                        await this._handleVscodeUndo();
                        break;
                }
            }, null, this._disposables),
        );

        // Watch for document saves to auto-refresh preview
        this._disposables.push(
            vscode.workspace.onDidSaveTextDocument(async savedDoc => {
                if (savedDoc.uri.fsPath === document.uri.fsPath) {
                    if (this._skipNextReload) {
                        this._skipNextReload = false;
                        return;
                    }
                    await this._loadAndRender(savedDoc);
                }
            }),
        );
    }

    private async _loadAndRender(document: vscode.TextDocument) {
        const content = document.getText();
        const systems = parseSolarSystemFile(content);

        this._panel.webview.postMessage({
            command: 'render',
            data: systems,
            fileName: path.basename(document.fileName),
        });
    }

    public dispose() {
        SolarSystemPanel.currentPanel = undefined;
        this._document = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ── Property editing ────────────────────────────────────────────────────

    /**
     * Format a property value as PDX script text.
     */
    private _formatValue(property: string, value: unknown, valueType?: string): string {
        if (valueType === 'range' && typeof value === 'object' && value !== null) {
            const rangeVal = value as { min: number; max: number };
            return `{ min = ${rangeVal.min} max = ${rangeVal.max} }`;
        }
        if (valueType === 'random') return 'random';
        if (typeof value === 'number') {
            return Number.isInteger(value) ? String(value) : value.toFixed(1);
        }
        if (typeof value === 'string') {
            if (/\s/.test(value) || value.length === 0) return `"${value}"`;
            return value;
        }
        return String(value);
    }

    /**
     * Handle updateProperty from webview.
     * Supports inline (single-line) and multiline property formats.
     */
    private async _handleUpdateProperty(msg: {
        line: number;
        property: string;
        value: unknown;
        valueType?: 'fixed' | 'range' | 'random';
    }) {
        if (!this._document) return;
        const doc = this._document;

        // Save snapshot for undo
        const now = Date.now();
        if (now - this._lastSnapshotTime > 500) {
            this._contentSnapshots.push(doc.getText());
            this._lastSnapshotTime = now;
        }

        const property = msg.property;
        const newValueStr = this._formatValue(property, msg.value, msg.valueType);

        // Search for the property starting from the given line
        // Support both:
        // 1. Standalone line: `\t\torbit_distance = 80`
        // 2. Inline: `planet = { class = pc_xx orbit_distance = 80 size = 10 }`
        let found = false;
        for (let i = msg.line - 1; i < Math.min(msg.line + 30, doc.lineCount); i++) {
            const lineText = doc.lineAt(i).text;

            // Build a regex to match `property = <value>` within the line
            // <value> can be: a number, a word, "quoted string", random, or { ... }
            const propPattern = new RegExp(
                `(${property}\\s*=\\s*)` +       // group 1: key = 
                `(\\{[^}]*\\}|"[^"]*"|\\S+)`,    // group 2: value (block, quoted, or word)
            );
            const match = propPattern.exec(lineText);
            if (match) {
                const startCol = match.index + match[1].length;
                const endCol = startCol + match[2].length;
                const range = new vscode.Range(
                    new vscode.Position(i, startCol),
                    new vscode.Position(i, endCol),
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, range, newValueStr);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
                found = true;
                break;
            }

            // Also check for multi-line block e.g.:
            // orbit_angle = {
            //     min = 90 max = 270
            // }
            const multiLineKeyPattern = new RegExp(`(${property}\\s*=\\s*)\\{\\s*$`);
            const multiMatch = multiLineKeyPattern.exec(lineText);
            if (multiMatch) {
                // Find the closing brace
                let endLineIdx = i;
                for (let j = i + 1; j < doc.lineCount; j++) {
                    if (doc.lineAt(j).text.includes('}')) {
                        endLineIdx = j;
                        break;
                    }
                }
                const startCol = multiMatch.index + multiMatch[1].length;
                const endLine = doc.lineAt(endLineIdx);
                const closeBraceCol = endLine.text.indexOf('}') + 1;
                const range = new vscode.Range(
                    new vscode.Position(i, startCol),
                    new vscode.Position(endLineIdx, closeBraceCol),
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, range, newValueStr);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
                found = true;
                break;
            }

            // Stop at closing brace (only if it's a standalone closing brace)
            if (lineText.trim() === '}' && i > msg.line - 1) break;
        }

        if (!found) {
            // Property not found — insert inline or as new line
            const targetLine = doc.lineAt(msg.line - 1);
            const lineText = targetLine.text;

            // If the element is inline (single line with { ... })
            // Insert the property before the closing brace
            const lastBrace = lineText.lastIndexOf('}');
            if (lastBrace > 0 && lineText.includes('{')) {
                const insertPos = new vscode.Position(msg.line - 1, lastBrace);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, insertPos, `${property} = ${newValueStr} `);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            } else {
                // Multi-line block: insert on next line
                const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
                const childIndent = indent + '\t';
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, new vscode.Position(msg.line - 1, lineText.length),
                    '\n' + childIndent + `${property} = ${newValueStr}`);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }
        }

        // Re-render
        await this._loadAndRender(doc);
    }

    /**
     * Handle adding a new planet to the system.
     * msg: { command, systemEndLine, orbitDistance, orbitAngle, planetClass, size }
     */
    private async _handleAddPlanet(msg: {
        systemEndLine: number;
        orbitDistance: number;
        orbitAngle: number;
        planetClass: string;
        size: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        // Save snapshot
        this._contentSnapshots.push(doc.getText());
        this._lastSnapshotTime = Date.now();

        // Insert before the system's closing brace
        const insertLineIdx = msg.systemEndLine - 1; // 1-indexed to 0-indexed
        const closingLine = doc.lineAt(insertLineIdx);
        const indent = closingLine.text.match(/^(\s*)/)?.[1] ?? '';
        const planetIndent = indent + '\t';

        const planetCode = `${planetIndent}planet = { class = ${msg.planetClass} orbit_distance = ${msg.orbitDistance} orbit_angle = ${msg.orbitAngle} size = ${msg.size} }\n`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(insertLineIdx, 0), planetCode);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await this._loadAndRender(doc);
    }

    /**
     * Handle batch orbit update (distance + angle in a single edit).
     */
    private async _handleUpdateOrbit(msg: {
        line: number;
        orbitDistance: number;
        orbitAngle: number;
    }) {
        if (!this._document) return;
        const doc = this._document;

        this._contentSnapshots.push(doc.getText());
        this._lastSnapshotTime = Date.now();

        const distStr = this._formatValue('orbit_distance', msg.orbitDistance, 'fixed');
        const angleStr = this._formatValue('orbit_angle', msg.orbitAngle, 'fixed');

        // Apply both replacements to the same WorkspaceEdit
        const edit = new vscode.WorkspaceEdit();
        let foundDist = false, foundAngle = false;

        for (let i = msg.line - 1; i < Math.min(msg.line + 30, doc.lineCount); i++) {
            const lineText = doc.lineAt(i).text;

            if (!foundDist) {
                const distPattern = /(orbit_distance\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/;
                const m = distPattern.exec(lineText);
                if (m) {
                    const startCol = m.index + m[1].length;
                    edit.replace(doc.uri, new vscode.Range(i, startCol, i, startCol + m[2].length), distStr);
                    foundDist = true;
                }
            }
            if (!foundAngle) {
                const anglePattern = /(orbit_angle\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/;
                const m = anglePattern.exec(lineText);
                if (m) {
                    const startCol = m.index + m[1].length;
                    edit.replace(doc.uri, new vscode.Range(i, startCol, i, startCol + m[2].length), angleStr);
                    foundAngle = true;
                }
            }

            if (foundDist && foundAngle) break;
            if (lineText.trim() === '}' && i > msg.line - 1) break;
        }

        if (foundDist || foundAngle) {
            this._skipNextReload = true;
            await vscode.workspace.applyEdit(edit);
            await doc.save();
        }
        await this._loadAndRender(doc);
    }

    /**
     * Handle deleting a planet/body from the system.
     */
    private async _handleDeletePlanet(msg: { line: number }) {
        if (!this._document) return;
        const doc = this._document;

        this._contentSnapshots.push(doc.getText());
        this._lastSnapshotTime = Date.now();

        const startLineIdx = msg.line - 1;
        const lineText = doc.lineAt(startLineIdx).text;

        let endLineIdx = startLineIdx;

        // Check if it's an inline definition (has both { and } on the same line)
        if (lineText.includes('{') && lineText.includes('}')) {
            endLineIdx = startLineIdx;
        } else if (lineText.includes('{')) {
            // Multi-line block: find the matching closing brace
            let depth = 0;
            for (let i = startLineIdx; i < doc.lineCount; i++) {
                const lt = doc.lineAt(i).text;
                for (const ch of lt) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (depth <= 0) {
                    endLineIdx = i;
                    break;
                }
            }
        }

        // Delete from start of startLine to start of endLine+1 (removes entire lines)
        const deleteEnd = endLineIdx + 1 < doc.lineCount
            ? new vscode.Position(endLineIdx + 1, 0)
            : doc.lineAt(endLineIdx).range.end;
        const edit = new vscode.WorkspaceEdit();
        edit.delete(doc.uri, new vscode.Range(new vscode.Position(startLineIdx, 0), deleteEnd));
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await this._loadAndRender(doc);
    }

    /**
     * Handle moving a planet to a new orbit, potentially reordering code blocks.
     * Stellaris orbit_distance is cumulative: each planet's resolved orbit =
     * cumulative_from_previous_bodies + own orbit_distance.
     * Inter-body change_orbit blocks also affect the cumulative chain.
     */
    private async _handleMovePlanetOrbit(msg: {
        bodyLine: number;
        bodyEndLine: number;
        targetResolvedOrbit: number;
        targetOrbitAngle: number;
        isRingWorld?: boolean;
        ringChangeOrbitLine?: number;
        ringOldOrbitRadius?: number;
        ringFirstLine?: number;
        ringLastEndLine?: number;
        ringTargetSegCount?: number;
        ringNewAngle?: number;
        ringOrigSegCount?: number;
    }) {
        const log = SolarSystemPanel._getLog();
        log.appendLine(`--- movePlanetOrbit msg: bodyLine=${msg.bodyLine} endLine=${msg.bodyEndLine} targetOrbit=${msg.targetResolvedOrbit} angle=${msg.targetOrbitAngle} isRing=${msg.isRingWorld}`);

        if (!this._document) { log.appendLine('  ABORT: no document'); return; }
        const doc = this._document;

        this._contentSnapshots.push(doc.getText());
        this._lastSnapshotTime = Date.now();

        // ── Ring world move: modify the change_orbit before the ring ─────────
        if (msg.isRingWorld && msg.ringChangeOrbitLine && msg.ringChangeOrbitLine > 0) {
            const content = doc.getText();
            const lines = content.split(/\r?\n/);
            const changeOrbitIdx = msg.ringChangeOrbitLine - 1;
            const oldLine = lines[changeOrbitIdx];
            log.appendLine(`  RING: changeOrbitLine=${msg.ringChangeOrbitLine} oldLine="${oldLine}"`);

            // Compute the delta
            const systems = parseSolarSystemFile(content);
            let ringGroup: any = null;
            for (const s of systems) {
                for (const b of s.bodies) {
                    if (b.ringGroup && b.line === msg.bodyLine) {
                        ringGroup = b.ringGroup;
                        break;
                    }
                }
                if (ringGroup) break;
            }
            const oldRadius = ringGroup?.orbitRadius ?? msg.ringOldOrbitRadius ?? 0;
            const delta = msg.targetResolvedOrbit - oldRadius;

            // Parse old change_orbit value and compute new
            const match = oldLine.match(/change_orbit\s*=\s*(-?\d+)/);
            if (match) {
                const oldValue = parseInt(match[1]);
                const newValue = oldValue + Math.round(delta);
                const newLine = oldLine.replace(/change_orbit\s*=\s*-?\d+/, `change_orbit = ${newValue}`);
                lines[changeOrbitIdx] = newLine;
                log.appendLine(`  RING: oldValue=${oldValue} delta=${Math.round(delta)} newValue=${newValue}`);

                // ── Ring expansion: update orbit_angles and add new segments ──
                const origSegCount = msg.ringOrigSegCount ?? ringGroup?.segments?.length ?? 0;
                const targetSegCount = msg.ringTargetSegCount ?? origSegCount;
                const newAngle = msg.ringNewAngle ?? (origSegCount > 0 ? 360 / origSegCount : 30);

                log.appendLine(`  RING EXPAND: origSegs=${origSegCount} targetSegs=${targetSegCount} newAngle=${newAngle}`);

                if (targetSegCount > origSegCount && ringGroup?.segments) {
                    // 1. Update all existing segments' orbit_angle
                    //    Must search all lines within each segment's block (multi-line planets)
                    for (const seg of ringGroup.segments) {
                        for (let li = seg.line - 1; li < seg.endLine && li < lines.length; li++) {
                            if (/orbit_angle\s*=/.test(lines[li])) {
                                lines[li] = lines[li].replace(
                                    /orbit_angle\s*=\s*\S+/,
                                    `orbit_angle = ${newAngle}`,
                                );
                                break;
                            }
                        }
                    }

                    // 2. Determine indentation from last segment
                    const lastSeg = ringGroup.segments[ringGroup.segments.length - 1];
                    const lastSegLine = lines[lastSeg.endLine - 1] || '';
                    const indent = lastSegLine.match(/^(\s*)/)?.[1] ?? '\t';

                    // 3. Build new segment lines
                    const newSegsToAdd = targetSegCount - origSegCount;
                    const newSegLines: string[] = [];
                    for (let i = 0; i < newSegsToAdd; i++) {
                        newSegLines.push(`${indent}planet = { class = pc_ringworld_seam orbit_angle = ${newAngle} orbit_distance = 0 }`);
                    }

                    // 4. Insert after the last existing ring segment
                    const insertAt = lastSeg.endLine; // 1-indexed endLine → insert at this 0-indexed position
                    lines.splice(insertAt, 0, ...newSegLines);

                    log.appendLine(`  RING EXPAND: added ${newSegsToAdd} seam segments after line ${lastSeg.endLine}`);
                } else if (targetSegCount === origSegCount && ringGroup?.segments) {
                    // Same segment count but orbit changed, just update orbit_angles in case they changed
                    // (no-op if angles are the same)
                }

                const newContent = lines.join('\n');
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    doc.lineAt(doc.lineCount - 1).range.end,
                );
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, fullRange, newContent);
                this._skipNextReload = true;
                await vscode.workspace.applyEdit(edit);
                await doc.save();
                log.appendLine(`  RING: saved`);
                await this._loadAndRender(doc);
            } else {
                log.appendLine(`  RING: could not parse change_orbit line`);
            }
            return;
        }

        const content = doc.getText();
        const systems = parseSolarSystemFile(content);
        log.appendLine(`  parsed ${systems.length} systems`);

        // Find the system and body (search bodies AND moons)
        let system: SolarSystem | undefined;
        let movedBody: CelestialBody | undefined;
        let isMoon = false;
        for (const s of systems) {
            for (const b of s.bodies) {
                if (b.line === msg.bodyLine) { movedBody = b; system = s; break; }
                for (const m of b.moons) {
                    if (m.line === msg.bodyLine) { movedBody = m; system = s; isMoon = true; break; }
                }
                if (system) break;
            }
            if (system) break;
        }

        if (!system || !movedBody) {
            log.appendLine(`  FALLBACK: system=${!!system} movedBody=${!!movedBody} isMoon=${isMoon}`);
            // Log all body lines for debugging
            for (const s of systems) {
                log.appendLine(`  system "${s.key}" bodies: ${s.bodies.map(b => `L${b.line}(${b.bodyType})`).join(', ')}`);
                for (const b of s.bodies) {
                    if (b.moons.length) log.appendLine(`    moons of L${b.line}: ${b.moons.map(m => `L${m.line}`).join(', ')}`);
                }
            }
            await this._handleUpdateOrbit({
                line: msg.bodyLine,
                orbitDistance: Math.round(msg.targetResolvedOrbit),
                orbitAngle: Math.round(msg.targetOrbitAngle),
            });
            return;
        }

        // For moons: compute correct cumulative and update in-place
        if (isMoon) {
            const rawDist = resolveValue(movedBody.orbitDistance);
            const cumAtPos = movedBody.resolvedOrbitRadius - rawDist;
            const newDist = Math.max(0, Math.round(msg.targetResolvedOrbit - cumAtPos));
            log.appendLine(`  MOON: rawDist=${rawDist} cum=${cumAtPos} newDist=${newDist}`);
            await this._handleUpdateOrbit({
                line: msg.bodyLine,
                orbitDistance: newDist,
                orbitAngle: Math.round(msg.targetOrbitAngle),
            });
            return;
        }

        // For planets: compute cumulative correctly
        const planets = system.bodies.filter(b => b.bodyType !== 'star');
        const currentIdx = planets.indexOf(movedBody);
        if (currentIdx < 0) { log.appendLine(`  ABORT: currentIdx < 0`); return; }

        // True cumulative at this body's position = resolvedOrbit - rawOrbitDistance
        const rawDist = resolveValue(movedBody.orbitDistance);
        const cumAtCurrentPos = movedBody.resolvedOrbitRadius - rawDist;
        const inPlaceNewDist = Math.max(0, Math.round(msg.targetResolvedOrbit - cumAtCurrentPos));

        // Check if reorder is needed: use the RAW target (not the clamped value)
        const prevBody = currentIdx > 0 ? planets[currentIdx - 1] : null;
        const nextBody = currentIdx < planets.length - 1 ? planets[currentIdx + 1] : null;
        const needsReorder =
            (msg.targetResolvedOrbit < cumAtCurrentPos) ||  // target below cumulative → can't achieve with non-negative orbit_distance
            (prevBody && msg.targetResolvedOrbit < prevBody.resolvedOrbitRadius) ||
            (nextBody && msg.targetResolvedOrbit > nextBody.resolvedOrbitRadius);

        log.appendLine(`  PLANET: idx=${currentIdx} resolved=${movedBody.resolvedOrbitRadius} rawDist=${rawDist} cum=${cumAtCurrentPos}`);
        log.appendLine(`  inPlaceNewDist=${inPlaceNewDist} target=${msg.targetResolvedOrbit}`);
        log.appendLine(`  prev=${prevBody?.resolvedOrbitRadius ?? 'none'} next=${nextBody?.resolvedOrbitRadius ?? 'none'}`);
        log.appendLine(`  needsReorder=${needsReorder}`);
        log.show(true);

        if (!needsReorder) {
            // Simple in-place update
            await this._handleUpdateOrbit({
                line: msg.bodyLine,
                orbitDistance: inPlaceNewDist,
                orbitAngle: Math.round(msg.targetOrbitAngle),
            });
            return;
        }

        // ── Reorder needed: cut body, re-parse, find insertion, paste ────────
        log.appendLine(`  REORDER: cutting body from lines ${msg.bodyLine}-${msg.bodyEndLine}`);
        const lines = content.split(/\r?\n/);
        const bodyStartIdx = msg.bodyLine - 1;
        const bodyEndIdx = msg.bodyEndLine - 1;

        // Extract and remove body block
        const bodyBlock = lines.slice(bodyStartIdx, bodyEndIdx + 1);
        log.appendLine(`  extracted ${bodyBlock.length} lines: "${bodyBlock[0]?.substring(0, 60)}..."`);
        lines.splice(bodyStartIdx, bodyEndIdx - bodyStartIdx + 1);

        // Re-parse the remaining content to get accurate cumulative orbits
        const remainingContent = lines.join('\n');
        const reSystems = parseSolarSystemFile(remainingContent);
        const reSystem = reSystems.find(s => s.key === system!.key);
        if (!reSystem) {
            log.appendLine(`  ABORT: reSystem not found! systems: ${reSystems.map(s => s.key).join(', ')}`);
            return;
        }

        const rePlanets = reSystem.bodies.filter(b => b.bodyType !== 'star');
        log.appendLine(`  re-parsed: ${rePlanets.length} planets: ${rePlanets.map(p => `L${p.line}(r=${p.resolvedOrbitRadius})`).join(', ')}`);

        // Find insertion point in the re-parsed (body-removed) data
        // Skip ring world groups as atomic blocks
        let insertBefore = rePlanets.length;
        for (let i = 0; i < rePlanets.length; i++) {
            // Skip hidden ring segments (they belong to the previous anchor)
            if (rePlanets[i].ringSegmentHidden) continue;
            if (msg.targetResolvedOrbit <= rePlanets[i].resolvedOrbitRadius) {
                insertBefore = i;
                break;
            }
            // If this is a ring group anchor, skip past all its hidden segments
            if (rePlanets[i].ringGroup) {
                while (i + 1 < rePlanets.length && rePlanets[i + 1].ringSegmentHidden) {
                    i++;
                }
            }
        }

        // Compute cumulative at insertion point from re-parsed data
        // We insert AFTER the previous body (before any change_orbit blocks between bodies)
        // so we use the previous body's end cumulative, not the target body's start cumulative.
        let cumOrbit = 0;
        if (insertBefore > 0) {
            // Find the actual "previous" body (skip hidden ring segments backwards)
            let prevIdx = insertBefore - 1;
            while (prevIdx > 0 && rePlanets[prevIdx].ringSegmentHidden) {
                prevIdx--;
            }
            const prevPlanet = rePlanets[prevIdx];
            // If previous is a ring group anchor, use the ring's orbit + its trailing changeOrbit
            if (prevPlanet.ringGroup) {
                // After a ring group, cumulative = ring orbit + any change_orbit after the ring
                const lastSegIdx = insertBefore - 1;
                const lastSeg = rePlanets[lastSegIdx];
                cumOrbit = lastSeg.resolvedOrbitRadius + lastSeg.changeOrbit;
            } else {
                cumOrbit = prevPlanet.resolvedOrbitRadius + prevPlanet.changeOrbit;
            }
        } else if (insertBefore < rePlanets.length) {
            // Inserting before the first planet
            // Check if there's a star body (bodyType === 'star') contributing to cumulative
            const star = reSystem.bodies.find(b => b.bodyType === 'star');
            if (star) {
                cumOrbit = star.resolvedOrbitRadius + star.changeOrbit;
            }
        }

        const newOrbitDist = Math.max(0, Math.round(msg.targetResolvedOrbit - cumOrbit));
        const newOrbitAngle = Math.round(msg.targetOrbitAngle);
        log.appendLine(`  insertBefore=${insertBefore} cumOrbit=${cumOrbit} newOrbitDist=${newOrbitDist}`);

        // Update orbit values in the body text
        let bodyText = bodyBlock.join('\n');
        bodyText = bodyText.replace(
            /(orbit_distance\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/,
            `$1${newOrbitDist}`,
        );
        bodyText = bodyText.replace(
            /(orbit_angle\s*=\s*)(\{[^}]*\}|"[^"]*"|\S+)/,
            `$1${newOrbitAngle}`,
        );

        // Find insertion line in the remaining-content line array
        // Insert AFTER the previous body (not before the target body) to avoid
        // landing after change_orbit blocks
        let insertLineIdx: number;
        if (insertBefore > 0) {
            // Find the end of the previous body (or ring group)
            let prevIdx = insertBefore - 1;
            while (prevIdx > 0 && rePlanets[prevIdx].ringSegmentHidden) {
                prevIdx--;
            }
            const prevPlanet = rePlanets[prevIdx];
            if (prevPlanet.ringGroup) {
                insertLineIdx = prevPlanet.ringGroup.lastEndLine;
            } else {
                insertLineIdx = prevPlanet.endLine;
            }
        } else if (rePlanets.length > 0) {
            // Before first planet but after star
            const star = reSystem.bodies.find(b => b.bodyType === 'star');
            insertLineIdx = star ? star.endLine : rePlanets[0].line - 1;
        } else {
            insertLineIdx = reSystem.endLine - 1;
        }
        log.appendLine(`  insertLineIdx=${insertLineIdx} (0-indexed in remaining content)`);
        log.appendLine(`  modified body: "${bodyText.substring(0, 80)}..."`);

        // Insert modified body block
        const newBodyLines = bodyText.split('\n');
        lines.splice(insertLineIdx, 0, ...newBodyLines);

        // Replace entire document
        const newContent = lines.join('\n');
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end,
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, newContent);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        log.appendLine(`  DONE: document saved`);
        await this._loadAndRender(doc);
    }

    private async _handleVscodeUndo() {
        if (!this._document) return;
        const snapshot = this._contentSnapshots.pop();
        if (!snapshot) return;
        const doc = this._document;
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end,
        );
        edit.replace(doc.uri, fullRange, snapshot);
        this._skipNextReload = true;
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        await this._loadAndRender(doc);
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private _getHtml(): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRootPath, 'solarSystemPreview.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._webviewRootPath, 'solarSystemPreview.js'))
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${this._panel.webview.cspSource} 'unsafe-inline';" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>星系预览</title>
</head>
<body>
    <div id="toolbar">
        <span id="title">星系预览</span>
        <div id="controls">
            <select id="system-select" title="选择星系"></select>
            <span class="separator">|</span>
            <button id="btn-zoom-in" title="放大">+</button>
            <span id="zoom-level">100%</span>
            <button id="btn-zoom-out" title="缩小">−</button>
            <button id="btn-fit" title="适应窗口">⊡</button>
            <button id="btn-reset" title="重置视角">↻</button>
            <span class="separator">|</span>
            <span id="tilt-level">55°</span>
            <span class="separator">|</span>
            <button id="btn-edit" title="切换编辑模式 (E)" class="edit-toggle">✏️</button>
            <button id="btn-labels" title="切换标签">🏷️</button>
            <button id="btn-orbits" title="切换轨道线">◎</button>
        </div>
    </div>
    <div id="main-layout">
        <div id="viewport">
            <canvas id="solar-canvas"></canvas>
        </div>
        <div id="side-panel" class="hidden">
            <div id="side-panel-tabs">
                <button id="tab-info" class="tab active">信息</button>
                <button id="tab-properties" class="tab">属性</button>
            </div>
            <div id="info-panel">
                <div id="system-info">选择一个星系查看详情</div>
            </div>
            <div id="properties-panel" class="hidden">
                <div id="props-content">选择一个天体以编辑属性</div>
            </div>
        </div>
    </div>
    <div id="tooltip" class="hidden"></div>
    <div id="context-menu" class="hidden">
        <div class="ctx-title">添加天体</div>
        <button data-action="add-continental">🌍 大陆星球</button>
        <button data-action="add-ocean">🌊 海洋星球</button>
        <button data-action="add-tropical">🌴 热带星球</button>
        <button data-action="add-desert">🏜️ 沙漠星球</button>
        <button data-action="add-arctic">❄️ 极地星球</button>
        <button data-action="add-arid">☀️ 干旱星球</button>
        <button data-action="add-gas_giant">🪐 气态巨行星</button>
        <button data-action="add-barren">🪨 贫瘠星球</button>
        <button data-action="add-frozen">🧊 冰冻星球</button>
        <button data-action="add-molten">🔥 熔融星球</button>
        <button data-action="add-toxic">☣️ 剧毒星球</button>
        <button data-action="add-asteroid">💫 小行星</button>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
    return t;
}
