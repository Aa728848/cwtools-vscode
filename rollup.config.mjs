import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';

const sharedPlugins = [
    replace({
        preventAssignment: true,
        'process.env.NODE_ENV': JSON.stringify('development'),
    }),
    typescript({
        tsconfig: "tsconfig.webview.json",
        clean: true,
        tsconfigOverride: {
            exclude: ["client/test/**/*", "**/*.test.ts", "client/extension/**", "client/common/**"]
        }
    }),
    resolve({
        browser: true,
        moduleDirectories: ['node_modules'],
        extensions: ['.ts', '.js'],
        resolveOnly: [
            /^(?!.*test).*$/
        ]
    }),
    commonjs({
        sourceMap: false,
        include: [
            'node_modules/**',
            'client/webview/**'
        ],
        exclude: [
            'client/test/**',
            'client/common/**',
            'client/extension/**',
            '**/*.test.ts'
        ]
    }),
];

export default [
    // Graph webview bundle (existing)
    {
        input: './client/webview/graph.ts',
        output: {
            file: './release/bin/client/webview/graph.js',
            format: "iife",
            name: "cwtoolsgraph",
            indent: false,
            banner: 'window.process = { env: { NODE_ENV: "development" } };'
        },
        plugins: sharedPlugins,
    },
    // GUI Preview webview bundle (new)
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
];