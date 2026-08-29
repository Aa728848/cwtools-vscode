import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Inline copy plugin — copies a plain JS file to the output directory */
function copyFile(src, dest) {
    return {
        name: 'copy-file',
        buildEnd() {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(src, dest);
        }
    };
}

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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/staticGalaxyPreview.css', 'release/bin/client/webview/staticGalaxyPreview.css'),
        ],
    },
    // Chat Panel webview bundle
    {
        input: './client/webview/chatPanel.ts',
        output: {
            file: './release/bin/client/webview/chatPanel.js',
            format: "iife",
            name: "cwtoolschatpanel",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview-chat.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/chatPanel.css', 'release/bin/client/webview/chatPanel.css'),
            copyFile('node_modules/mermaid/dist/mermaid.min.js', 'release/bin/client/webview/mermaid.min.js'),
        ],
    },
    // Agent Manager webview bundle
    {
        input: './client/webview/agentManager.ts',
        output: {
            file: './release/bin/client/webview/agentManager.js',
            format: "iife",
            name: "cwtoolsagentmanager",
            indent: false,
        },
        plugins: [
            typescript({
                tsconfig: ".config/tsconfig.webview-chat.json",
                clean: true,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/agentManager.css', 'release/bin/client/webview/agentManager.css'),
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/techTreePreview.css', 'release/bin/client/webview/techTreePreview.css'),
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/entityPreview.css', 'release/bin/client/webview/entityPreview.css'),
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/particlePreview.css', 'release/bin/client/webview/particlePreview.css'),
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
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
        ],
    },
];
