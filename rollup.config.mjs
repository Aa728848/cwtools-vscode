import typescript from 'rollup-plugin-typescript2';
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
            // Also copy plain-JS webview files that don't need bundling
            copyFile('./client/webview/chatPanel.js', './release/bin/client/webview/chatPanel.js'),
        ],
    },
];