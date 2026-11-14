import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    activeWorkBuddyAtRestKey,
    deriveWorkBuddyKeyId,
    isWorkBuddySealedValue,
    openWorkBuddySealedField,
    openWorkBuddySealedFile,
    parseWorkBuddyAtRestKeyText,
    sealWorkBuddyValue,
    setActiveWorkBuddyAtRestKey,
    verifyWorkBuddyKeyAgainstKeyBlob,
} from '../../extension/ai/workbuddy/atrest';
import {
    WorkBuddyCredentialStore,
    parseWorkBuddyCredentials,
    scanWorkBuddyDesktopCredentials,
    unsealWorkBuddyCredentials,
    workBuddyAccountKey,
    workBuddySealedDiagnostics,
    writeBackWorkBuddyDesktopCredential,
    type WorkBuddyCredentials,
} from '../../extension/ai/workbuddy/credentials';
import { sanitizeWorkBuddyText } from '../../extension/ai/workbuddy/outboundIdentity';
import {
    classifyWorkBuddyFailure,
    prepareWorkBuddyChatPayload,
    prepareWorkBuddyMessagesPayload,
    relocateWorkBuddySystemToInstructions,
    workBuddyChatSystemKey,
    workBuddyHeaders,
} from '../../extension/ai/workbuddy/client';
import {
    localDateString,
    runWorkBuddyCheckinOnce,
    runWorkBuddyCheckinPass,
    type WorkBuddyCheckinState,
} from '../../extension/ai/workbuddy/checkin';
import {
    clearCachedWorkBuddyQuota,
    fetchWorkBuddyQuota,
    parseWorkBuddyBilling,
    workBuddyBillingMeters,
} from '../../extension/ai/workbuddy/quota';

const vscodeStub = {
    env: { language: 'en' },
    window: {
        createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined,
    },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
};

function loadCheckinServiceModule() {
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: unknown, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/workbuddy/checkinService') as typeof import('../../extension/ai/workbuddy/checkinService');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function sampleCreds(overrides: Partial<WorkBuddyCredentials> = {}): WorkBuddyCredentials {
    return {
        accessToken: 'wb-access-1',
        refreshToken: 'wb-refresh-1',
        expiresAt: Date.now() + 3600_000,
        domain: 'copilot.tencent.com',
        backend: 'https://copilot.tencent.com',
        region: 'cn',
        uid: 'uid-100',
        nickname: 'Tester',
        source: 'desktop',
        sourceFile: '',
        sourceMtimeMs: 0,
        ...overrides,
    };
}

describe('WorkBuddy $wbEncrypted at-rest key and desktop credentials', () => {
    const prevAuthDir = process.env.CODEBUDDY_AUTH_DIR;

    afterEach(() => {
        setActiveWorkBuddyAtRestKey(null);
        if (prevAuthDir === undefined) delete process.env.CODEBUDDY_AUTH_DIR;
        else process.env.CODEBUDDY_AUTH_DIR = prevAuthDir;
    });

    it('parses 64-hex and 44-base64 keys and round-trips AES-256-GCM field and file envelopes', async () => {
        const rawKey = randomBytes(32);
        const hexKey = parseWorkBuddyAtRestKeyText(rawKey.toString('hex'));
        expect(hexKey.equals(rawKey)).to.equal(true);

        const b64Input = `${randomBytes(32).toString('base64').slice(0, 43)}=`;
        const b64Key = parseWorkBuddyAtRestKeyText(b64Input);
        expect(b64Key.length).to.equal(32);

        const fieldEnv = sealWorkBuddyValue(rawKey, 'tok-secret-field', 'field');
        const fileEnv = sealWorkBuddyValue(rawKey, '{"ok":true}', 'file');
        expect(isWorkBuddySealedValue(fieldEnv)).to.equal(true);
        expect(openWorkBuddySealedField(rawKey, fieldEnv)).to.equal('tok-secret-field');
        expect(openWorkBuddySealedFile(rawKey, fileEnv)).to.equal('{"ok":true}');
        expect(() => openWorkBuddySealedField(b64Key, fieldEnv)).to.throw();

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-keyblob-'));
        try {
            const keyFile = path.join(tmpDir, '.wb-key');
            fs.writeFileSync(keyFile, JSON.stringify({ keyId: deriveWorkBuddyKeyId(rawKey) }), 'utf8');
            await verifyWorkBuddyKeyAgainstKeyBlob(rawKey, [keyFile]);

            let mismatchErr: unknown;
            try {
                await verifyWorkBuddyKeyAgainstKeyBlob(b64Key, [keyFile]);
            } catch (err) {
                mismatchErr = err;
            }
            expect(mismatchErr).to.be.instanceOf(Error);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('tracks sealed file diagnostics without leaking secrets and never downgrades sealed files on write-back', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scan-'));
        try {
            process.env.CODEBUDDY_AUTH_DIR = tmpDir;
            const key = randomBytes(32);
            const infoPath = path.join(tmpDir, 'workbuddy-desktop.info');
            const sealedAccess = sealWorkBuddyValue(key, 'plain-access-from-seal', 'field');
            const sealedRefresh = sealWorkBuddyValue(key, 'plain-refresh-from-seal', 'field');
            fs.writeFileSync(infoPath, JSON.stringify({
                auth: {
                    accessToken: sealedAccess,
                    refreshToken: sealedRefresh,
                    domain: 'copilot.tencent.com',
                    expiresAt: Date.now() + 3600_000,
                },
                account: { uid: 'u-sealed', nickname: 'SealedUser' },
            }), 'utf8');

            // 1. Without active key: unsealing is skipped safely and diagnostics record missingKey
            const scannedLocked = scanWorkBuddyDesktopCredentials(tmpDir);
            expect(scannedLocked).to.have.length(0);
            expect(workBuddySealedDiagnostics()).to.include({ sealedFiles: 1, opened: 0, missingKey: true });

            // 2. Write-back guard: must NOT clobber sealed file with plaintext when key is missing
            const lockedRawBefore = fs.readFileSync(infoPath, 'utf8');
            writeBackWorkBuddyDesktopCredential(sampleCreds({
                accessToken: 'refreshed-plaintext',
                source: 'desktop',
                sourceFile: infoPath,
            }));
            expect(fs.readFileSync(infoPath, 'utf8')).to.equal(lockedRawBefore);

            // 3. With key adopted: scans unsealed credentials AND write-back re-seals instead of downgrading
            const box = new Map<string, string>();
            const store = new WorkBuddyCredentialStore({
                get: async k => box.get(k),
                store: async (k, v) => { box.set(k, v); },
                delete: async k => { box.delete(k); },
            });
            const keyId = await store.adoptAtRestKey(key.toString('hex'), []);
            expect(keyId).to.equal(deriveWorkBuddyKeyId(key));
            expect(activeWorkBuddyAtRestKey()?.equals(key)).to.equal(true);
            expect(JSON.stringify(workBuddySealedDiagnostics())).to.not.contain(key.toString('hex'));

            const scannedOpen = scanWorkBuddyDesktopCredentials(tmpDir);
            expect(scannedOpen).to.have.length(1);
            expect(scannedOpen[0]!.accessToken).to.equal('plain-access-from-seal');
            expect(workBuddySealedDiagnostics()).to.include({ sealedFiles: 1, opened: 1, missingKey: false });

            writeBackWorkBuddyDesktopCredential({
                ...scannedOpen[0]!,
                accessToken: 'rotated-access-token',
                refreshToken: 'rotated-refresh-token',
            });
            const writtenDoc = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { auth: Record<string, unknown> };
            expect(isWorkBuddySealedValue(writtenDoc.auth.accessToken)).to.equal(true);
            expect(openWorkBuddySealedField(key, writtenDoc.auth.accessToken)).to.equal('rotated-access-token');

            // Unseal directly rejects parse if secret key removed
            await store.clearAtRestKey();
            const parsedLocked = parseWorkBuddyCredentials(writtenDoc, 'desktop', infoPath, 0)!;
            expect(unsealWorkBuddyCredentials(parsedLocked)).to.equal(null);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('WorkBuddy outbound hygiene, payload shaping, and failure classification', () => {
    it('scrubs third-party harness fingerprints and emits desktop conversation + telemetry headers', () => {
        const cleaned = sanitizeWorkBuddyText("You are Claude Code, Anthropic's official CLI for Claude.\n\0powered by DeepSeek Harness");
        expect(cleaned).to.not.contain('\0');
        expect(cleaned).to.not.contain('Claude Code');
        expect(cleaned).to.not.contain('DeepSeek Harness');

        const cnChatHeaders = workBuddyHeaders(sampleCreds(), {
            chat: true,
            gzipBody: true,
            accountKey: workBuddyAccountKey(sampleCreds()),
            sessionId: 'sess-1',
            turnKey: '0:hello',
        });
        expect(cnChatHeaders['user-agent']).to.include('WorkBuddy/5.9.3 WorkBuddy/5.9.3');
        expect(cnChatHeaders['content-encoding']).to.equal('gzip');
        expect(cnChatHeaders['x-conversation-id']).to.be.a('string').with.length(36);
        expect(cnChatHeaders['acp-connection-id']).to.be.a('string').with.length(36);
        expect(cnChatHeaders.traceparent).to.match(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

        const cnMessagesHeaders = workBuddyHeaders(sampleCreds(), { messages: true, gzipBody: true });
        expect(cnMessagesHeaders['anthropic-version']).to.equal('2023-06-01');
        expect(cnMessagesHeaders['content-encoding']).to.equal(undefined);
    });

    it('merges split assistant tool_call turns, fills missing tool responses, forces streaming, and prepares /v1/messages payloads', () => {
        const payload = prepareWorkBuddyChatPayload({
            model: 'gpt-5.5',
            max_tokens: 4,
            stream: false,
            messages: [
                { role: 'user', content: 'Hi Claude Code\0' },
                { role: 'assistant', content: 'Step 1', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
                { role: 'assistant', content: 'Step 2', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'c1', content: 'ok' },
                { role: 'user', content: 'Continue' },
            ],
        });

        expect(payload.stream).to.equal(true);
        expect(payload.stream_options).to.deep.equal({ include_usage: true });
        expect(payload.cache_retention).to.equal('long');
        expect(payload.max_tokens).to.equal(16);

        const msgs = payload.messages as Array<Record<string, unknown>>;
        expect(msgs[0]).to.deep.equal({ role: 'system', content: 'You are a helpful assistant.' });
        expect(msgs[2]!.role).to.equal('assistant');
        expect((msgs[2]!.tool_calls as unknown[]).length).to.equal(2);
        // Synthetic missing tool result inserted after 'c1' and before trailing 'Continue' user message
        expect(msgs[4]).to.deep.equal({
            role: 'tool',
            tool_call_id: 'c2',
            content: '[no result: the tool call did not complete]',
        });

        const claudeBody = prepareWorkBuddyMessagesPayload({
            model: 'claude-sonnet-4.6',
            stream: false,
            system: 'x-anthropic-billing-header: foo\nYou are Claude Code, Anthropic\'s official CLI for Claude.',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'OhMyOpenCode test\0' }] }],
        });
        expect(claudeBody.stream).to.equal(true);
        expect(claudeBody.system).to.equal('You are an AI coding assistant.');
        expect(claudeBody.messages).to.deep.equal([
            { role: 'user', content: [{ type: 'text', text: 'coding-assistant test' }] },
        ]);
    });

    it('separates 11128 channel refusal relocation from 11159 thinking signature and 11140 account restriction', () => {
        // 11128 relocates custom system once into <INSTRUCTIONS>
        const c11128 = classifyWorkBuddyFailure(403, '{"code":11128,"msg":"unapproved channel"}');
        expect(c11128).to.deep.include({ kind: 'channel_refusal_11128', canRelocateSystem: true });

        const original = {
            messages: [
                { role: 'system', content: 'Custom system rules' },
                { role: 'user', content: 'Hello' },
            ],
        };
        const relocatedOnce = relocateWorkBuddySystemToInstructions(original)!;
        expect(relocatedOnce).to.not.equal(null);
        expect((relocatedOnce.messages as Array<{ role: string; content: string }>)[0]!.content).to.equal('You are a helpful assistant.');
        expect((relocatedOnce.messages as Array<{ role: string; content: string }>)[1]!.content).to.equal('<INSTRUCTIONS>\nCustom system rules\n</INSTRUCTIONS>\n\nHello');
        expect(workBuddyChatSystemKey(relocatedOnce)).to.equal('');
        // Guard against infinite relocation loop: second relocation returns null
        expect(relocateWorkBuddySystemToInstructions(relocatedOnce)).to.equal(null);

        // 11159 must NEVER relocate system
        expect(classifyWorkBuddyFailure(400, '{"code":11159,"msg":"invalid thinking signature"}').kind)
            .to.equal('thinking_signature_refused');
        // 11140 permanently restricts account
        expect(classifyWorkBuddyFailure(403, '{"code":11140,"msg":"restricted"}'))
            .to.deep.include({ kind: 'account_restricted', code: 11140, permanent: true });
        // 429 / 6004 cooldown parses reset timestamp when present
        const now = Date.UTC(2026, 10, 14, 10, 0, 0);
        const rateLimit = classifyWorkBuddyFailure(429, '{"code":6004,"msg":"resets at 2026-11-14 10:30:00 UTC+0"}', undefined, now);
        expect(rateLimit.kind).to.equal('rate_limited');
        if (rateLimit.kind === 'rate_limited') {
            expect(rateLimit.retryAfterMs).to.equal(30 * 60_000);
        }
    });
});

describe('WorkBuddy CN daily check-in and billing quota', () => {
    beforeEach(() => clearCachedWorkBuddyQuota());

    it('enforces idempotent daily check-in and summarizes across CN vs INTL accounts', async () => {
        const nowMs = new Date(2026, 10, 14, 12, 0, 0).getTime();
        const state: WorkBuddyCheckinState = {};
        let checkinCalls = 0;

        const first = await runWorkBuddyCheckinOnce('acct-cn', sampleCreds(), state, {
            ensureFresh: async c => c,
            readState: async () => state,
            writeState: async () => undefined,
            fetchFn: async (input) => {
                const url = String(input);
                if (url.includes('checkin-activity-status')) {
                    return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }), { status: 200 });
                }
                checkinCalls += 1;
                return new Response(JSON.stringify({ code: 0, data: { streak_days: 3, total_credits: 30 } }), { status: 200 });
            },
        }, nowMs);
        expect(first).to.deep.equal({ accountId: 'acct-cn', signedIn: true, inactive: false, streakDays: 3, totalCredits: 30 });
        expect(checkinCalls).to.equal(1);

        // Second check on same day is a zero-network idempotent hit
        const second = await runWorkBuddyCheckinOnce('acct-cn', sampleCreds(), state, {
            ensureFresh: async c => c,
            readState: async () => state,
            writeState: async () => undefined,
            fetchFn: async () => { throw new Error('must not call network when already checked in today'); },
        }, nowMs);
        expect(second.signedIn).to.equal(true);

        // Full service filters out INTL accounts and produces summary
        const { WorkBuddyCheckinService } = loadCheckinServiceModule();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-checkin-'));
        try {
            const service = new WorkBuddyCheckinService({
                storageDir: tmpDir,
                isEnabled: () => true,
                pauseFn: async () => undefined,
                randomFn: () => 0,
                ensureFresh: async c => c,
                accounts: async () => [
                    { id: 'cn-1', credentials: sampleCreds({ uid: 'cn-1', domain: 'copilot.tencent.com', region: 'cn' }) },
                    { id: 'intl-1', credentials: sampleCreds({ uid: 'intl-1', domain: 'www.workbuddy.ai', region: 'intl' }) },
                ],
                fetchFn: async (input) => {
                    const url = String(input);
                    if (url.includes('checkin-activity-status')) {
                        return new Response(JSON.stringify({ code: 0, data: { active: true, today_checked_in: true, streak_days: 1 } }), { status: 200 });
                    }
                    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
                },
            });
            await service.run(nowMs);
            const summary = await service.summary(nowMs);
            expect(summary.accountCount).to.equal(1);
            expect(summary.signedInCount).to.equal(1);
            expect(summary.signedInToday).to.equal(true);
            service.stop();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }

        // Batch pass skips network when already done on same calendar day
        const today = localDateString(nowMs);
        const passState: WorkBuddyCheckinState = { 'done-acct': { date: today, done: true, attempts: 0 } };
        const passRes = await runWorkBuddyCheckinPass(
            [{ id: 'done-acct', credentials: sampleCreds() }],
            {
                ensureFresh: async c => c,
                readState: async () => passState,
                writeState: async () => undefined,
                fetchFn: async () => { throw new Error('unexpected network'); },
            },
            nowMs,
        );
        expect(passRes).to.deep.equal([{ accountId: 'done-acct', signedIn: true, inactive: false }]);
    });

    it('parses multi-package billing resources and caches quota per account key', async () => {
        const billing = parseWorkBuddyBilling({
            code: 0,
            data: {
                Response: {
                    Data: {
                        Accounts: [
                            { PackageName: 'Pro Plan', CapacitySize: 500, CapacityRemain: 200, CycleCapacityUsed: 50, CycleCapacitySize: 100, CycleEndTime: '2026-11-30 23:59:59' },
                            { PackageName: 'Bonus', CapacitySize: 100, CapacityRemain: 100, CycleCapacityUsed: 0, CycleCapacitySize: 0 },
                        ],
                    },
                },
            },
        });
        expect(billing.totalCredits).to.equal(600);
        expect(billing.remainingCredits).to.equal(300);
        const meters = workBuddyBillingMeters(billing);
        expect(meters).to.have.length(2);
        expect(meters[0]!.id).to.equal('cycle');
        expect(meters[0]!.usedPercent).to.equal(0.5);
        expect(meters[1]!.id).to.equal('package');
        expect(meters[1]!.usedPercent).to.equal(0.5);

        let fetches = 0;
        const quota = await fetchWorkBuddyQuota(sampleCreds(), 'uid:uid-100', {
            fetchFn: async () => {
                fetches += 1;
                return new Response(JSON.stringify({
                    code: 0,
                    data: { Response: { Data: { Accounts: [{ CapacitySize: 100, CapacityRemain: 25 }] } } },
                }), { status: 200 });
            },
        });
        expect(quota.meters[0]!.usedPercent).to.be.closeTo(0.75, 1e-6);
        await fetchWorkBuddyQuota(sampleCreds(), 'uid:uid-100', {
            fetchFn: async () => {
                fetches += 1;
                return new Response('{}', { status: 200 });
            },
        });
        expect(fetches).to.equal(1);
    });
});
