import typescript from 'rollup-plugin-typescript2';

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
];