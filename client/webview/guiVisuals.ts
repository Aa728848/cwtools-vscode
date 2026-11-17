import type { GuiElement } from '../shared/guiPreview';

/** Shared multi-frame and nine-slice texture behavior for both GUI surfaces. */
export function applyGuiImageStyles(img: HTMLImageElement, div: HTMLElement, el: GuiElement): void {
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    if (el.spriteDefType === 'corneredTileSpriteType') {
        const bx = el.borderSize?.x ?? 0;
        const by = el.borderSize?.y ?? 0;
        if (bx > 0 || by > 0) {
            img.style.display = 'none';
            const drawNineSlice = () => {
                const canvas = document.createElement('canvas');
                Object.assign(canvas.style, {
                    position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
                    pointerEvents: 'none', opacity: '0.90',
                });
                const dw = div.offsetWidth || Number.parseInt(div.style.width, 10) || 200;
                const dh = div.offsetHeight || Number.parseInt(div.style.height, 10) || 200;
                canvas.width = dw;
                canvas.height = dh;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                const sw = img.naturalWidth;
                const sh = img.naturalHeight;
                if (!sw || !sh) return;
                const sl = Math.min(bx, sw / 2);
                const sr = Math.min(bx, sw / 2);
                const st = Math.min(by, sh / 2);
                const sb = Math.min(by, sh / 2);
                const scw = sw - sl - sr;
                const sch = sh - st - sb;
                const dl = Math.min(bx, dw / 2);
                const dr = Math.min(bx, dw / 2);
                const dt = Math.min(by, dh / 2);
                const db = Math.min(by, dh / 2);
                const dcw = dw - dl - dr;
                const dch = dh - dt - db;
                if (sl > 0 && st > 0) ctx.drawImage(img, 0, 0, sl, st, 0, 0, dl, dt);
                if (scw > 0 && st > 0) ctx.drawImage(img, sl, 0, scw, st, dl, 0, dcw, dt);
                if (sr > 0 && st > 0) ctx.drawImage(img, sw - sr, 0, sr, st, dw - dr, 0, dr, dt);
                if (sl > 0 && sch > 0) ctx.drawImage(img, 0, st, sl, sch, 0, dt, dl, dch);
                if (scw > 0 && sch > 0) ctx.drawImage(img, sl, st, scw, sch, dl, dt, dcw, dch);
                if (sr > 0 && sch > 0) ctx.drawImage(img, sw - sr, st, sr, sch, dw - dr, dh - db, dr, db);
                if (sl > 0 && sb > 0) ctx.drawImage(img, 0, sh - sb, sl, sb, 0, dh - db, dl, db);
                if (scw > 0 && sb > 0) ctx.drawImage(img, sl, sh - sb, scw, sb, dl, dh - db, dcw, db);
                if (sr > 0 && sb > 0) ctx.drawImage(img, sw - sr, sh - sb, sr, sb, dw - dr, dh - db, dr, db);
                div.querySelectorAll('canvas').forEach(item => item.remove());
                div.appendChild(canvas);
            };
            if (img.complete && img.naturalWidth > 0) requestAnimationFrame(drawNineSlice);
            else img.onload = () => requestAnimationFrame(drawNineSlice);
        } else {
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'fill';
        }
    } else if (el.noOfFrames && el.noOfFrames > 1) {
        img.style.width = `${el.noOfFrames * 100}%`;
        img.style.height = '100%';
        img.style.objectFit = 'fill';
        const frame = Math.max(0, Math.min((el.frame ?? 1) - 1, el.noOfFrames - 1));
        img.style.left = `-${frame * 100}%`;
        div.style.overflow = 'hidden';
        img.dataset.animFrames = String(el.noOfFrames);
        img.dataset.animCurrent = String(frame);
    }
}
