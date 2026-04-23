const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');

const project = new Project({
    tsConfigFilePath: './tsconfig.webview.json',
});

const srcFilePath = 'client/webview/guiPreview.ts';
const sourceFile = project.getSourceFile(srcFilePath);

if (!sourceFile) {
    console.error('Source file not found!');
    process.exit(1);
}

// Ensure dir exists
const fs = require('fs');
if (!fs.existsSync('client/webview/gui')) {
    fs.mkdirSync('client/webview/gui', { recursive: true });
}

// 1. Create target files
const typesFile = project.createSourceFile('client/webview/gui/types.ts', '', { overwrite: true });
const layoutFile = project.createSourceFile('client/webview/gui/layout.ts', '', { overwrite: true });
const rendererFile = project.createSourceFile('client/webview/gui/renderer.ts', '', { overwrite: true });
const editorFile = project.createSourceFile('client/webview/gui/editor.ts', '', { overwrite: true });

// Function definitions by layer
const layoutFns = [
    'normalizeOrientation', 'orientationToAnchor', 'origoToOffset',
    'computeTopLeft', 'effectiveSize', 'computeSnap'
];

const rendererFns = [
    'updateTransform', 'applyImageStyles', 'toggleSpriteAnimations',
    'renderElement', 'renderAll', 'syncDivVisuals', 'buildLayerTree'
];

const editorFns = [
    'showTip', 'hideTip', 'fitToView', 'setupControls', 'updateLayersPanel',
    'setupSearch', 'toggleEditMode', 'selectElement', 'toggleSelection',
    'clearSelection', 'addResizeHandles', 'removeResizeHandles', 'startDrag',
    'startResize', 'handleResizeMove', 'finishResize', 'showDragTooltip',
    'hideDragTooltip', 'pushUndo', 'undo', 'redo', 'showSnapGuides',
    'clearSnapGuides', 'updateAlignButtons', 'alignSelected', 'updatePropertiesPanel',
    'setupAutocomplete', 'propRow', 'escHtml', 'applyPropertyChange',
    'showContextMenu', 'hideContextMenu', 'setupContextMenu', 'handleContextAction',
    'findChild', 'findParentOf', 'findElementByLine', 'getElementCanvasPos',
    'reparentSelectedInto', 'unparentSelected', 'startReparentTargetSelection',
    'cancelReparentMode', 'handleReparentTargetClick', 'deleteSelected',
    'duplicateSelected', 'setupEditorKeyboard', 'setupSidePanelTabs', 'setupAlignButtons',
    'shouldUseScale'
];

// Helper to move a function
function moveFunction(name, targetFile) {
    const fn = sourceFile.getFunction(name);
    if (fn) {
        // Automatically make it exported
        fn.setIsExported(true);
        // Copy to target
        targetFile.addFunction(fn.getStructure());
        fn.remove();
    }
}

function moveInterface(name, targetFile) {
    const intf = sourceFile.getInterface(name);
    if (intf) {
        intf.setIsExported(true);
        targetFile.addInterface(intf.getStructure());
        intf.remove();
    }
}

// 2. Move Types
moveInterface('GuiElement', typesFile);
const colorsVar = sourceFile.getVariableStatement('COLORS');
if (colorsVar) {
    colorsVar.setIsExported(true);
    typesFile.addVariableStatement(colorsVar.getStructure());
    colorsVar.remove();
}
const defaultColor = sourceFile.getVariableStatement('DEFAULT_COLOR');
if (defaultColor) {
    defaultColor.setIsExported(true);
    typesFile.addVariableStatement(defaultColor.getStructure());
    defaultColor.remove();
}

// 3. Move Functions
rendererFns.forEach(fn => moveFunction(fn, rendererFile));
layoutFns.forEach(fn => moveFunction(fn, layoutFile));
editorFns.forEach(fn => moveFunction(fn, editorFile));

// 4. In guiPreview.ts, we need to export everything that's remaining or left globally
// We'll just run a quick fix / auto import script
for (const file of [typesFile, layoutFile, rendererFile, editorFile, sourceFile]) {
    file.fixMissingImports();
    file.organizeImports();
}

// Add index.ts to export all
project.createSourceFile('client/webview/gui/index.ts', `
export * from './types';
export * from './layout';
export * from './renderer';
export * from './editor';
`, { overwrite: true });

project.saveSync();
console.log('Successfully modularized guiPreview.ts via ts-morph!');
