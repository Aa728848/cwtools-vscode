/**
 * VS Code Webview API — ambient declaration shared by all webview scripts.
 * Each webview file calls `acquireVsCodeApi()` to obtain the API object.
 */
interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Minimal OrbitControls declarations for the APIs used by the webviews. */
declare module 'three/examples/jsm/controls/OrbitControls.js' {
    import { Camera, Controls, MOUSE, Vector3 } from 'three';

    export interface OrbitControlsEventMap {
        change: {};
        start: {};
        end: {};
    }

    export class OrbitControls extends Controls<OrbitControlsEventMap> {
        constructor(object: Camera, domElement?: HTMLElement | SVGElement | null);
        target: Vector3;
        minDistance: number;
        maxDistance: number;
        enableDamping: boolean;
        dampingFactor: number;
        enablePan: boolean;
        mouseButtons: {
            LEFT?: MOUSE | null | undefined;
            MIDDLE?: MOUSE | null | undefined;
            RIGHT?: MOUSE | null | undefined;
        };
        update(deltaTime?: number | null): boolean;
    }
}

/** Minimal TransformControls declarations for the APIs used by entityPreview. */
declare module 'three/examples/jsm/controls/TransformControls.js' {
    import { Camera, Controls, Object3D } from 'three';

    export type TransformControlsMode = 'translate' | 'rotate' | 'scale';
    export interface TransformControlsEventMap {
        change: {};
        mouseDown: { mode: TransformControlsMode };
        mouseUp: { mode: TransformControlsMode };
        objectChange: {};
        'dragging-changed': { value: boolean };
    }

    export class TransformControls extends Controls<TransformControlsEventMap> {
        constructor(camera: Camera, domElement?: HTMLElement | SVGElement | null);
        axis: 'X' | 'Y' | 'Z' | 'E' | 'XY' | 'YZ' | 'XZ' | 'XYZ' | 'XYZE' | null;
        mode: TransformControlsMode;
        space: 'world' | 'local';
        dragging: boolean;
        getHelper(): Object3D;
        attach(object: Object3D): this;
        detach(): this;
        getMode(): TransformControlsMode;
        setMode(mode: TransformControlsMode): void;
        setSpace(space: 'world' | 'local'): void;
        setSize(size: number): void;
        setTranslationSnap(translationSnap: number | null): void;
        setRotationSnap(rotationSnap: number | null): void;
    }
}
