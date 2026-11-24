/**
 * Rollup bundle configuration for all browser-sandboxed Webview entries and
 * the skybox environment Web Worker under `client/webview/`.
 *
 * Outputs IIFE bundles and copies static CSS / vendor assets into
 * `release/bin/client/webview/`.
 */
import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Inline copy plugin — copies a static asset (CSS or prebuilt JS) to the Webview output directory. */
function copyFile(src, dest) {
    return {
        name: 'copy-file',
        buildEnd() {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(src, dest);
        }
    };
}

/**
 * Native N-API modules kept external so Rollup never attempts to bundle them
 * into browser-sandboxed Webviews (the Extension Host loads `steamworks.js`
 * from `release/node_modules` at runtime).
 */
const EXTERNAL_NATIVE_MODULES = ['steamworks.js'];

export default [
    // GUI Preview webview bundle
    {
        input: './client/webview/guiPreview.ts',
        output: {
            file: './release/bin/client/webview/guiPreview.js',
            format: "iife",
            name: "cwtoolsguipreview",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/guiPreview.css', 'release/bin/client/webview/guiPreview.css'),
        ],
    },
    // Solar System Preview webview bundle
    {
        input: './client/webview/solarSystemPreview.ts',
        output: {
            file: './release/bin/client/webview/solarSystemPreview.js',
            format: "iife",
            name: "cwtoolssolarsystem",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview-solar.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/solarSystemPreview.css', 'release/bin/client/webview/solarSystemPreview.css'),
        ],
    },
    // Static Galaxy Preview/Editor webview bundle
    {
        input: './client/webview/staticGalaxyPreview.ts',
        output: {
            file: './release/bin/client/webview/staticGalaxyPreview.js',
            format: "iife",
            name: "cwtoolsstaticgalaxy",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview-galaxy.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/staticGalaxyPreview.css', 'release/bin/client/webview/staticGalaxyPreview.css'),
        ],
    },
    // Event Chain Preview webview bundle
    {
        input: './client/webview/eventChainPreview.ts',
        output: {
            file: './release/bin/client/webview/eventChainPreview.js',
            format: "iife",
            name: "cwtoolseventchain",
            indent: false,
        },
        plugins: [
            resolve({ browser: true }),
            commonjs(),
            typescript({
                tsconfig: ".config/tsconfig.webview-event.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/eventChainPreview.css', 'release/bin/client/webview/eventChainPreview.css'),
        ],
    },
    // Tech Tree Preview webview bundle
    {
        input: './client/webview/techTreePreview.ts',
        output: {
            file: './release/bin/client/webview/techTreePreview.js',
            format: "iife",
            name: "cwtoolstechtree",
            indent: false,
        },
        plugins: [
            resolve({ browser: true }),
            commonjs(),
            typescript({
                tsconfig: ".config/tsconfig.webview-tech.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/techTreePreview.css', 'release/bin/client/webview/techTreePreview.css'),
        ],
    },
    // Target Weight Analysis webview bundle
    {
        input: './client/webview/targetWeightPreview.ts',
        output: {
            file: './release/bin/client/webview/targetWeightPreview.js',
            format: "iife",
            name: "cwtoolstargetweight",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview.json",
                clean: true,
                tsconfigOverride: {
                    // Single-file webview: point the program at this entry plus the ambient
                    // `acquireVsCodeApi` declaration. Both slots of the base config's
                    // `include` are overridden, so the merge replaces it wholesale.
                    include: ["../client/webview/targetWeightPreview.ts", "../client/webview/vscode.d.ts"],
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/targetWeightPreview.css', 'release/bin/client/webview/targetWeightPreview.css'),
        ],
    },
    // Entity Preview webview bundle
    {
        input: './client/webview/entityPreview.ts',
        output: {
            file: './release/bin/client/webview/entityPreview.js',
            format: "iife",
            name: "cwtoolsentitypreview",
            indent: false,
        },
        plugins: [
            resolve({ browser: true }),
            commonjs(),
            typescript({
                tsconfig: ".config/tsconfig.webview-entity.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/entityPreview.css', 'release/bin/client/webview/entityPreview.css'),
        ],
    },
    // Global Ship Design Workbench webview bundle
    {
        input: './client/webview/shipDesignPreview.ts',
        output: {
            file: './release/bin/client/webview/shipDesignPreview.js',
            format: "iife",
            name: "cwtoolsshipdesignpreview",
            indent: false,
        },
        plugins: [
            resolve({ browser: true }),
            commonjs(),
            typescript({
                tsconfig: ".config/tsconfig.webview-ship-design.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/shipDesignPreview.css', 'release/bin/client/webview/shipDesignPreview.css'),
        ],
    },
    // Particle Preview / Editor webview bundle
    {
        input: './client/webview/particlePreview.ts',
        output: {
            file: './release/bin/client/webview/particlePreview.js',
            format: "iife",
            name: "cwtoolsparticlepreview",
            indent: false,
        },
        plugins: [
            resolve({ browser: true }),
            commonjs(),
            typescript({
                tsconfig: ".config/tsconfig.webview-particle.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
            copyFile('client/webview/particlePreview.css', 'release/bin/client/webview/particlePreview.css'),
        ],
    },
    // Steam Workshop Upload webview bundle
    {
        input: './client/webview/workshopUpload.ts',
        output: {
            file: './release/bin/client/webview/workshopUpload.js',
            format: "iife",
            name: "cwtoolsworkshopupload",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview.json",
                clean: true,
                tsconfigOverride: {
                    // Single-file webview: point the program at this entry plus the ambient
                    // `acquireVsCodeApi` declaration. Both slots of the base config's
                    // `include` are overridden, so the merge replaces it wholesale.
                    include: ["../client/webview/workshopUpload.ts", "../client/webview/vscode.d.ts"],
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
        ],
    },
    // Skybox environment decode worker (fetched as text, instantiated as Blob worker)
    {
        input: './client/webview/skyboxEnvWorker.ts',
        output: {
            file: './release/bin/client/webview/skyboxEnvWorker.js',
            format: "iife",
            name: "cwtoolsskyboxenvworker",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview-worker.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**"]
                }
            }),
        ],
    },
].map((config) => ({ external: EXTERNAL_NATIVE_MODULES, ...config }));
