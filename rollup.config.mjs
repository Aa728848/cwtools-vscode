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
                tsconfig: "tsconfig.webview.json",
                clean: false,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
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
                tsconfig: "tsconfig.webview-solar.json",
                clean: false,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
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
                tsconfig: "tsconfig.webview-chat.json",
                clean: false,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/chatPanel.css', 'release/bin/client/webview/chatPanel.css'),
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
                tsconfig: "tsconfig.webview-event.json",
                clean: false,
                tsconfigOverride: {
                    exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
                }
            }),
            copyFile('client/webview/eventChainPreview.css', 'release/bin/client/webview/eventChainPreview.css'),
        ],
    },
];