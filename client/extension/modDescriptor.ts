/**
 * `descriptor.mod` access shared by project profiling and workshop upload.
 *
 * The Paradox mod descriptor is the only place a mod declares its display
 * name, supported game version, tags, dependencies and the remote file id
 * Steam assigned to it. Profile building and the upload flow both need those
 * facts, so the parsing lives here instead of being duplicated per caller.
 *
 * This module deliberately avoids importing `vscode` so unit tests can load
 * it directly without stubs.
 */

import * as fs from 'fs';
import * as path from 'path';

/** File name of the Paradox mod descriptor at a mod root. */
export const DESCRIPTOR_FILE_NAME = 'descriptor.mod';

export interface ModDescriptor {
    exists: boolean;
    name?: string;
    version?: string;
    tags?: string[];
    supportedVersion?: string;
    remoteFileId?: string;
    dependencies?: string[];
    warnings?: string[];
}

/** Absolute path of the descriptor inside a mod root. */
export function getDescriptorPath(root: string): string {
    return path.join(root, DESCRIPTOR_FILE_NAME);
}

/**
 * Read `<root>/descriptor.mod`. Never throws: a missing or unreadable file
 * is reported through `exists` and `warnings` so callers can keep going.
 */
export function readDescriptor(root: string): ModDescriptor {
    const descriptorPath = getDescriptorPath(root);
    if (!fs.existsSync(descriptorPath)) return { exists: false };
    let content: string;
    try {
        content = fs.readFileSync(descriptorPath, 'utf8');
    } catch {
        return { exists: true, warnings: ['descriptor.mod is not readable; treating it as absent.'] };
    }
    const warnings: string[] = [];
    const name = content.match(/^name\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const version = content.match(/^version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const supportedVersion = content.match(/^supported_version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
    const remoteFileId = content.match(/^remote_file_id\s*=\s*"?(\d+)"?/m)?.[1]?.trim();
    const tagsBlock = content.match(/^tags\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    const tags = Array.from(tagsBlock.matchAll(/"([^"]+)"/g)).map(match => match[1]).filter((tag): tag is string => !!tag);
    const dependenciesBlock = content.match(/^dependencies\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
    const dependencies = Array.from(dependenciesBlock.matchAll(/"([^"]+)"/g))
        .map(match => match[1])
        .filter((value): value is string => !!value)
        .filter((value, index, values) => values.indexOf(value) === index);
    if (content.includes('supported_version') && !supportedVersion) warnings.push('descriptor.mod declares supported_version but it could not be parsed.');
    if (content.includes('remote_file_id') && !remoteFileId) warnings.push('descriptor.mod declares remote_file_id but it could not be parsed.');
    if (content.includes('dependencies') && dependencies.length === 0) warnings.push('descriptor.mod declares dependencies but none could be parsed.');
    return { exists: true, name, version, tags, supportedVersion, remoteFileId, dependencies, warnings };
}

const REMOTE_FILE_ID_LINE = /^([ \t]*remote_file_id[ \t]*=[ \t]*).*$/m;

/**
 * Write the Steam remote file id back into an existing `descriptor.mod`.
 *
 * Rewrites the value of an existing `remote_file_id=` line in place, keeping
 * its indentation and spacing, or appends the declaration when the file has
 * none. Line endings follow the file being edited, so a CRLF descriptor stays
 * CRLF. Ordinary `.mod` text is written as UTF-8; localisation `.yml` files
 * must never go through here.
 *
 * @throws when `id` is not numeric — a non-numeric value would be unreadable
 * by {@link readDescriptor} and would degrade the descriptor to a warning.
 */
export function writeRemoteFileId(descriptorPath: string, id: string): void {
    if (!/^\d+$/.test(id)) {
        throw new Error(`refusing to write a non-numeric remote_file_id to descriptor.mod: ${id}`);
    }
    // Read raw bytes and decode here: a string-mode read hands the line-ending
    // style to whatever text shim wraps `fs.readFileSync`, which would silently
    // rewrite a CRLF descriptor to LF.
    const content = fs.readFileSync(descriptorPath).toString('utf8');
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const declaration = `remote_file_id="${id}"`;
    let next: string;
    if (REMOTE_FILE_ID_LINE.test(content)) {
        next = content.replace(REMOTE_FILE_ID_LINE, (_match, prefix: string) => `${prefix}"${id}"`);
    } else {
        const body = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}${eol}`;
        next = `${body}${declaration}${eol}`;
    }
    fs.writeFileSync(descriptorPath, next, 'utf8');
}