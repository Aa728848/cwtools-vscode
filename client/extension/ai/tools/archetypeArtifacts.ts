import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ArchetypePlaceholders, ArchetypeSlotValue, ExtractedArchetype, ArchetypeContract } from './archetypeSlots';
import { extractArchetypeSlots, instantiateArchetypeSlots } from './archetypeSlots';

const MAX_ARTIFACTS = 64;
const ARTIFACT_TTL_MS = 15 * 60 * 1000;

export interface HostArchetypeExtractArgs {
    filePath: string;
    definitionIdentity: string;
    definitionPath: string;
    placeholders: ArchetypePlaceholders;
    scopeId: string;
}

export interface HostArchetypeArtifact {
    artifactId: string;
    definitionIdentity: string;
    definitionPath: string;
    sourceHash: string;
    contract: ArchetypeContract;
    expiresAt: string;
}

interface StoredArtifact {
    artifactId: string;
    definitionIdentity: string;
    ownerScopeId: string;
    canonicalRealpath: string;
    sourceHash: string;
    archetype: ExtractedArchetype;
    createdAt: number;
    expiresAt: number;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(message: string): never {
    throw new Error(`archetypeArtifact: ${message}`);
}

export class HostArchetypeArtifactStore {
    private readonly artifacts = new Map<string, StoredArtifact>();

    constructor(private readonly workspaceRoot: string, private readonly now: () => number = Date.now) {}

    async extract(
        args: HostArchetypeExtractArgs,
        verifyDefinition: (identity: string, canonicalRealpath: string) => Promise<{ content: string } | undefined>,
    ): Promise<HostArchetypeArtifact> {
        if (!args || typeof args.filePath !== 'string' || typeof args.definitionPath !== 'string'
            || typeof args.definitionIdentity !== 'string' || !args.definitionIdentity.trim() || typeof args.scopeId !== 'string' || !args.scopeId) {
            fail('filePath, definitionIdentity, and definitionPath are required');
        }
        const canonicalWorkspace = await fs.promises.realpath(this.workspaceRoot);
        const requested = path.resolve(this.workspaceRoot, args.filePath);
        const declaredDefinitionPath = path.resolve(this.workspaceRoot, args.definitionPath);
        const [canonicalSource, canonicalDefinitionPath] = await Promise.all([
            fs.promises.realpath(requested),
            fs.promises.realpath(declaredDefinitionPath),
        ]);
        const relative = path.relative(canonicalWorkspace, canonicalSource);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('source must be a workspace file');
        if (canonicalSource !== canonicalDefinitionPath) fail('definitionPath does not identify the source file');
        const stat = await fs.promises.stat(canonicalSource);
        if (!stat.isFile()) fail('source must be a regular file');
        const identity = args.definitionIdentity.trim();
        const verified = await verifyDefinition(identity, canonicalSource);
        if (!verified) fail('definition identity/path was not verified by the host');
        const fileText = await fs.promises.readFile(canonicalSource, 'utf8');
        const archetype = extractArchetypeSlots(verified.content, args.placeholders);
        const createdAt = this.now();
        this.prune(createdAt);
        while (this.artifacts.size >= MAX_ARTIFACTS) this.artifacts.delete(this.artifacts.keys().next().value as string);
        const artifactId = `arch_${randomBytes(24).toString('base64url')}`;
        const stored: StoredArtifact = {
            artifactId,
            definitionIdentity: identity,
            ownerScopeId: args.scopeId,
            canonicalRealpath: canonicalSource,
            sourceHash: sha256(fileText),
            archetype,
            createdAt,
            expiresAt: createdAt + ARTIFACT_TTL_MS,
        };
        this.artifacts.set(artifactId, stored);
        return {
            artifactId,
            definitionIdentity: identity,
            definitionPath: path.relative(canonicalWorkspace, canonicalSource).replace(/\\/g, '/'),
            sourceHash: stored.sourceHash,
            contract: archetype.contract,
            expiresAt: new Date(stored.expiresAt).toISOString(),
        };
    }

    async instantiate(artifactId: string, values: Readonly<Record<string, ArchetypeSlotValue>>, scopeId: string): Promise<string> {
        if (typeof artifactId !== 'string' || !/^arch_[A-Za-z0-9_-]{32}$/.test(artifactId)) fail('invalid artifactId');
        const now = this.now();
        this.prune(now);
        const artifact = this.artifacts.get(artifactId);
        if (!artifact || artifact.ownerScopeId !== scopeId) fail('artifact is expired, unknown, or belongs to another session');
        const canonicalCurrent = await fs.promises.realpath(artifact.canonicalRealpath);
        if (canonicalCurrent !== artifact.canonicalRealpath) fail('source realpath drift detected');
        const text = await fs.promises.readFile(canonicalCurrent, 'utf8');
        if (sha256(text) !== artifact.sourceHash) fail('source hash drift detected');
        return instantiateArchetypeSlots(artifact.archetype, values);
    }

    private prune(now: number): void {
        for (const [id, artifact] of this.artifacts) {
            if (artifact.expiresAt <= now) this.artifacts.delete(id);
        }
    }
}
